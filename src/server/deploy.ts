import { rmSync } from "node:fs";
import { upsertRoute } from "./caddy.ts";
import type { Emit, StepName } from "./events.ts";
import { run } from "./exec.ts";
import { httpGet } from "./http.ts";
import type { Target } from "./net.ts";
import { allocatePort, recordPort, targetString } from "./net.ts";
import type { ServerEnv } from "./paths.ts";
import { validateDomain } from "./paths.ts";
import { currentRelease, ensureStateDir, newReleaseDir, swapCurrent } from "./releases.ts";
import {
  installTemplate,
  instanceId,
  journalTail,
  listInstances,
  renderDropIn,
  retireInstance,
  startInstance,
  unitState,
  writeDropIn,
} from "./systemd.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long the outgoing release keeps running after the route moved off it,
 * so requests it was already serving can finish before it stops (#28).
 */
const DRAIN_MS = 500;

type PrepareCheck = "has-task" | "no-task" | "no-mise";

/** Does the release define a mise `prepare` task? */
async function checkPrepareTask(releaseDir: string): Promise<PrepareCheck> {
  try {
    // Non-interactive environments can't answer mise's trust prompt.
    await run(["mise", "trust", "--yes"], { cwd: releaseDir });
    const result = await run(["mise", "tasks", "ls", "--json"], {
      cwd: releaseDir,
      env: { MISE_TRUSTED_CONFIG_PATHS: releaseDir },
    });
    if (result.code !== 0) return "no-task";
    const tasks = JSON.parse(result.stdout) as Array<{ name: string }>;
    return tasks.some((t) => t.name === "prepare") ? "has-task" : "no-task";
  } catch {
    return "no-mise";
  }
}

/**
 * Poll until the app answers HTTP (non-5xx — a broken build that serves
 * errors must not replace a working release) on its port, or the unit dies,
 * or the timeout runs out.
 */
async function verifyAnswersHttp(
  domain: string,
  instance: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet("127.0.0.1", port, domain, 1000);
      if (res.status < 500) return true;
    } catch {
      if ((await unitState(instance)) === "failed") return false;
    }
    await sleep(250);
  }
  return false;
}

/**
 * The full deploy operation (spec #20): archive on fd 0 → unpack → prepare →
 * allocate address → unit → verify → cutover → route → confirm live →
 * decommission, emitting NDJSON step-events throughout. Returns the process
 * exit code.
 *
 * The cutover is blue-green (#28): every release is its own systemd instance
 * on its own port, started and VERIFYed while the previous release keeps
 * serving; traffic moves atomically at the route swap, and only then does the
 * outgoing instance stop. A failing deploy never touches what is live.
 */
export async function deployOp(
  domain: string,
  runCmd: string[],
  env: ServerEnv,
  emit: Emit,
): Promise<number> {
  validateDomain(domain);
  const start = (step: StepName) => emit({ event: "step", step, status: "start" });
  const ok = (step: StepName, detail?: string) =>
    emit({ event: "step", step, status: "ok", ...(detail ? { detail } : {}) });
  const fail = (step: StepName, message: string): number => {
    emit({ event: "step", step, status: "fail", detail: message });
    emit({ event: "error", message });
    return 1;
  };

  // unpack: the archive (git archive HEAD → tar) rides stdin per ADR 0006.
  start("unpack");
  const { name: release, dir: releaseDir } = newReleaseDir(env.appsDir, domain);
  const discardRelease = () => rmSync(releaseDir, { recursive: true, force: true });
  const tar = await run(["tar", "-xf", "-", "-C", releaseDir], { stdin: "inherit" });
  if (tar.code !== 0) {
    discardRelease();
    return fail("unpack", `tar exited ${tar.code}: ${tar.stderr.trim()}`);
  }
  ok("unpack", release);

  // prepare: build in the release dir before anything goes live.
  start("prepare");
  const prepareTask = await checkPrepareTask(releaseDir);
  if (prepareTask === "has-task") {
    const result = await run(["mise", "run", "prepare"], {
      cwd: releaseDir,
      env: { MISE_TRUSTED_CONFIG_PATHS: releaseDir },
    });
    if (result.code !== 0) {
      // Buffered build output goes to stderr on failure (ADR 0006).
      process.stderr.write(result.stdout + result.stderr);
      discardRelease();
      return fail("prepare", `mise run prepare exited ${result.code}`);
    }
    ok("prepare");
  } else {
    emit({
      event: "step",
      step: "prepare",
      status: "skip",
      detail: prepareTask === "no-mise" ? "mise not found" : "no prepare task",
    });
  }

  // allocate: a fresh port for this release. The live release's port is
  // recorded in net.toml (skipped by the scan) and its bind is probed, so the
  // two coexist; the new port becomes the recorded target only at cutover.
  start("allocate");
  const port = await allocatePort(env.appsDir, env.portBase);
  const target: Target = { host: "127.0.0.1", port };
  ok("allocate", targetString(target));

  // unit: start this release's own instance beside the live one, which keeps
  // serving untouched — it needs no rollback handle beyond staying up.
  start("unit");
  const instance = instanceId(domain, release);
  const previousRelease = currentRelease(env.appsDir, domain);
  installTemplate(env.unitDir);
  writeDropIn(
    env.unitDir,
    instance,
    renderDropIn({ releaseDir, port, stateDir: ensureStateDir(env.appsDir, domain), runCmd }),
  );

  const abandon = async (step: StepName, message: string): Promise<number> => {
    process.stderr.write(await journalTail(instance, 60));
    await retireInstance(env.unitDir, instance);
    discardRelease();
    message += previousRelease
      ? ` — previous release ${previousRelease} still serving`
      : " — nothing went live";
    return fail(step, message);
  };

  try {
    await startInstance(instance);
  } catch (err) {
    return abandon("unit", `failed to start unit: ${err instanceof Error ? err.message : err}`);
  }
  ok("unit");

  // verify: the app must answer HTTP before it can become current.
  start("verify");
  if (!(await verifyAnswersHttp(domain, instance, port, env.verifyTimeoutMs))) {
    return abandon("verify", `app did not answer HTTP on port ${port}`);
  }
  ok("verify");

  // cutover: only a verified release becomes current and the recorded target.
  start("cutover");
  swapCurrent(env.appsDir, domain, release);
  recordPort(env.appsDir, domain, port);
  ok("cutover", release);

  // route: Host → target through the Caddy admin API (zero-downtime). A
  // failure past this point deliberately skips decommission: the stale route
  // still points at the previous instance, so stopping it would take the
  // site down — the next successful deploy's sweep retires it instead.
  start("route");
  try {
    await upsertRoute(env.caddyAdmin, env.ingressListen, domain, target);
  } catch (err) {
    return fail("route", err instanceof Error ? err.message : String(err));
  }
  ok("route");

  // live: confirm the domain answers through the ingress.
  start("live");
  try {
    const res = await httpGet("127.0.0.1", env.ingressPort, domain, 5000);
    if (res.status >= 500) return fail("live", `ingress answered ${res.status} for ${domain}`);
  } catch (err) {
    return fail("live", `ingress check failed: ${err instanceof Error ? err.message : err}`);
  }
  ok("live");

  // decommission: traffic has moved — retire every other instance of the
  // domain (the outgoing release, plus any stray a crashed deploy left).
  const retirees = (await listInstances(domain)).filter((i) => i !== instance);
  if (retirees.length > 0) {
    start("decommission");
    await sleep(DRAIN_MS);
    for (const retiree of retirees) {
      await retireInstance(env.unitDir, retiree);
    }
    ok("decommission", previousRelease ?? undefined);
  }

  emit({ event: "deployed", domain, release, target: targetString(target) });
  return 0;
}
