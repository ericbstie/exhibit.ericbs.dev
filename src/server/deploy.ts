import { rmSync } from "node:fs";
import { upsertRoute } from "./caddy.ts";
import type { Emit, StepName } from "./events.ts";
import { run } from "./exec.ts";
import { httpGet } from "./http.ts";
import { ensurePort, resolveTarget, targetString } from "./net.ts";
import type { ServerEnv } from "./paths.ts";
import { validateDomain } from "./paths.ts";
import { currentRelease, newReleaseDir, swapCurrent } from "./releases.ts";
import {
  installTemplate,
  journalTail,
  readDropIn,
  renderDropIn,
  startApp,
  stopApp,
  unitState,
  writeDropIn,
} from "./systemd.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Does the release define a mise `prepare` task? */
async function hasPrepareTask(releaseDir: string): Promise<boolean | "no-mise"> {
  try {
    // Non-interactive environments can't answer mise's trust prompt.
    await run(["mise", "trust", "--yes"], { cwd: releaseDir });
    const result = await run(["mise", "tasks", "ls", "--json"], {
      cwd: releaseDir,
      env: { MISE_TRUSTED_CONFIG_PATHS: releaseDir },
    });
    if (result.code !== 0) return false;
    const tasks = JSON.parse(result.stdout) as Array<{ name: string }>;
    return tasks.some((t) => t.name === "prepare");
  } catch {
    return "no-mise";
  }
}

/** Poll until the app answers HTTP on its port, or the unit dies, or timeout. */
async function verifyAnswersHttp(domain: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await httpGet("127.0.0.1", port, domain, 1000);
      return true;
    } catch {
      if ((await unitState(domain)) === "failed") return false;
      await sleep(250);
    }
  }
  return false;
}

/**
 * The full deploy operation (spec #20): archive on fd 0 → unpack → prepare →
 * allocate address → unit → verify → cutover → route → confirm live, emitting
 * NDJSON step-events throughout. Returns the process exit code.
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
  const prepare = await hasPrepareTask(releaseDir);
  if (prepare === true) {
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
      detail: prepare === "no-mise" ? "mise not found" : "no prepare task",
    });
  }

  // allocate: the address seam — recorded once, reused on redeploy.
  start("allocate");
  const port = await ensurePort(env.appsDir, domain, env.portBase);
  const target = resolveTarget(env.appsDir, domain)!;
  ok("allocate", targetString(target));

  // unit: point the app's instance at the new release and (re)start it.
  // The previous drop-in is the rollback handle if VERIFY fails.
  start("unit");
  const previousDropIn = readDropIn(env.unitDir, domain);
  const previousRelease = currentRelease(env.appsDir, domain);
  installTemplate(env.unitDir);
  writeDropIn(env.unitDir, domain, renderDropIn({ releaseDir, port, runCmd }));

  const rollback = async (step: StepName, message: string): Promise<number> => {
    process.stderr.write(await journalTail(domain, 60));
    if (previousDropIn !== null) {
      writeDropIn(env.unitDir, domain, previousDropIn);
      try {
        await startApp(domain);
      } catch (err) {
        process.stderr.write(`rollback restart failed: ${err}\n`);
      }
      message += ` — previous release ${previousRelease ?? "(unknown)"} restored`;
    } else {
      // First deploy: fail cleanly with nothing half-live.
      await stopApp(env.unitDir, domain);
      message += " — nothing went live";
    }
    discardRelease();
    return fail(step, message);
  };

  try {
    await startApp(domain);
  } catch (err) {
    return rollback("unit", `failed to start unit: ${err instanceof Error ? err.message : err}`);
  }
  ok("unit");

  // verify: the app must answer HTTP before it can become current.
  start("verify");
  if (!(await verifyAnswersHttp(domain, port, env.verifyTimeoutMs))) {
    return rollback("verify", `app did not answer HTTP on port ${port}`);
  }
  ok("verify");

  // cutover: only a verified release becomes current.
  start("cutover");
  swapCurrent(env.appsDir, domain, release);
  ok("cutover", release);

  // route: Host → target through the Caddy admin API (zero-downtime).
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
    await httpGet("127.0.0.1", env.ingressPort, domain, 5000);
  } catch (err) {
    return fail("live", `ingress check failed: ${err instanceof Error ? err.message : err}`);
  }
  ok("live");

  emit({ event: "deployed", domain, release, target: targetString(target) });
  return 0;
}
