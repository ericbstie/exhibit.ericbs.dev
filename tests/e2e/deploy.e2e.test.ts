import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { httpGet } from "../../src/server/http.ts";
import {
  appArchive,
  cleanupApp,
  E2E,
  freshServerEnv,
  INGRESS_PORT,
  PYTHON_SERVER,
  pythonApp,
  resetCaddy,
  runServer,
  RUN_PYTHON,
  sleep,
} from "./harness.ts";

// A fixture using the real mise contract: `prepare` builds body.txt before
// cutover, `production` is the long-running server (default run command).
const MISE_APP = {
  "server.py": PYTHON_SERVER,
  "mise.toml":
    `[tasks.prepare]\n` +
    `run = "python3 -c 'open(\\"body.txt\\",\\"w\\").write(\\"prepared-v1\\")'"\n\n` +
    `[tasks.production]\nrun = "python3 server.py"\n`,
};

const BROKEN_BUILD_APP = {
  "server.py": PYTHON_SERVER,
  "mise.toml": `[tasks.prepare]\nrun = "echo BUILD_BROKEN_MARKER && exit 1"\n`,
};

// T4 (#25): the full deploy operation — release dirs, prepare, verify, safe
// cutover, NDJSON step-events.
describe.skipIf(!E2E)("full deploy operation", () => {
  const env = freshServerEnv("t4", 4400);
  const domainA = "t4-a.test";
  const domainB = "t4-b.test";

  beforeAll(resetCaddy);
  afterAll(async () => {
    await cleanupApp(domainA);
    await cleanupApp(domainB);
  });

  let firstRelease: string;

  test("first deploy: 200 through the ingress, current points at the release, unit active", async () => {
    // No `--`: exercises the default run command, `mise run production`.
    const result = await runServer(["deploy", "--domain", domainA], {
      env,
      stdin: appArchive(MISE_APP),
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    // Deploy emits NDJSON step-events on stdout — every line parses.
    const lines = result.stdout.split("\n").filter((l) => l.trim());
    expect(result.events.length).toBe(lines.length);
    const okSteps: string[] = result.events
      .filter((e) => e.event === "step" && e.status === "ok")
      .map((e) => (e.event === "step" ? e.step : ""));
    for (const step of ["unpack", "prepare", "allocate", "unit", "verify", "cutover", "route", "live"]) {
      expect(okSteps).toContain(step);
    }
    const deployed = result.events.find((e) => e.event === "deployed");
    expect(deployed).toBeDefined();
    firstRelease = deployed!.event === "deployed" ? deployed!.release : "";

    // prepare ran in the release dir before cutover: the served body proves it.
    const res = await httpGet("127.0.0.1", INGRESS_PORT, domainA);
    expect(res.status).toBe(200);
    expect(res.raw).toContain("prepared-v1");

    const ls = await runServer(["ls"], { env });
    expect(ls.stdout).toContain(`* ${firstRelease}`);
    const unit = `exhibit-app@${domainA}.service`;
    expect(Bun.spawnSync(["systemctl", "is-active", unit]).stdout.toString().trim()).toBe(
      "active",
    );
  });

  test("redeploy: 200 throughout the cutover, old release still on disk", async () => {
    const results: number[] = [];
    let stop = false;
    const hammer = (async () => {
      while (!stop) {
        try {
          results.push((await httpGet("127.0.0.1", INGRESS_PORT, domainA, 6000)).status);
        } catch (err) {
          results.push(-1);
        }
        await sleep(50);
      }
    })();

    const redeploy = await runServer(["deploy", "--domain", domainA, ...RUN_PYTHON], {
      env,
      stdin: appArchive(pythonApp("v2-shipped")),
    });
    stop = true;
    await hammer;
    expect(redeploy.code).toBe(0);

    // No downtime window: every request during the cutover answered 200.
    expect(results.length).toBeGreaterThan(5);
    expect(results.every((status) => status === 200)).toBe(true);
    expect((await httpGet("127.0.0.1", INGRESS_PORT, domainA)).raw).toContain("v2-shipped");

    // The old release is still on disk; current moved.
    const ls = await runServer(["ls"], { env });
    expect(ls.stdout).toContain(`  ${firstRelease}`);
    expect(ls.stdout).not.toContain(`* ${firstRelease}`);
  });

  test("a release that fails VERIFY leaves the previous version serving and is removed", async () => {
    const before = await runServer(["ls"], { env });
    const releaseCount = (before.stdout.match(/\d{8}-\d{6}/g) ?? []).length;

    const result = await runServer(
      ["deploy", "--domain", domainA, "--", "python3", "-c", "import time; time.sleep(600)"],
      { env, stdin: appArchive(pythonApp("never-answers")) },
    );
    expect(result.code).not.toBe(0);
    expect(result.events.some((e) => e.event === "error")).toBe(true);

    // Previous version still serving through the ingress.
    const res = await httpGet("127.0.0.1", INGRESS_PORT, domainA);
    expect(res.status).toBe(200);
    expect(res.raw).toContain("v2-shipped");

    // The failed release was auto-cleaned (ADR 0005).
    const after = await runServer(["ls"], { env });
    expect((after.stdout.match(/\d{8}-\d{6}/g) ?? []).length).toBe(releaseCount);
  });

  test("a first deploy that fails its build errors cleanly with nothing live", async () => {
    const freshEnv = freshServerEnv("t4-first-fail", 4450);
    const domain = "t4-broken.test";
    const result = await runServer(["deploy", "--domain", domain], {
      env: freshEnv,
      stdin: appArchive(BROKEN_BUILD_APP),
    });
    expect(result.code).not.toBe(0);
    // Buffered build output surfaces on stderr (ADR 0006).
    expect(result.stderr).toContain("BUILD_BROKEN_MARKER");

    // Nothing live: no unit running, no release kept.
    const unit = `exhibit-app@${domain}.service`;
    expect(Bun.spawnSync(["systemctl", "is-active", unit]).stdout.toString().trim()).not.toBe(
      "active",
    );
    const ls = await runServer(["ls"], { env: freshEnv });
    expect(ls.stdout.match(/\d{8}-\d{6}/)).toBeNull();
  });

  test("two domains on one box each serve their own 200, isolated", async () => {
    const result = await runServer(["deploy", "--domain", domainB, ...RUN_PYTHON], {
      env,
      stdin: appArchive(pythonApp("b-body")),
    });
    expect(result.code).toBe(0);
    expect((await httpGet("127.0.0.1", INGRESS_PORT, domainA)).raw).toContain("v2-shipped");
    expect((await httpGet("127.0.0.1", INGRESS_PORT, domainB)).raw).toContain("b-body");
  });
});
