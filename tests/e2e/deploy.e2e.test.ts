import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { httpGet } from "../../src/server/http.ts";
import {
  appArchive,
  appUnits,
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
  const domainState = "t4-state.test";

  beforeAll(resetCaddy);
  afterAll(async () => {
    await cleanupApp(domainA);
    await cleanupApp(domainB);
    await cleanupApp(domainState);
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

  test("a release that fails VERIFY leaves the previous version serving throughout — no downtime window", async () => {
    const before = await runServer(["ls"], { env });
    const releaseCount = (before.stdout.match(/\d{8}-\d{6}/g) ?? []).length;

    // Concurrent traffic for the whole failing deploy, verify window included:
    // the prior release must keep answering 200 the entire time (spec #20
    // story 11 / #28 — this loop is what would have caught the old cutover's
    // mid-verify outage).
    const results: number[] = [];
    let stop = false;
    const hammer = (async () => {
      while (!stop) {
        try {
          results.push((await httpGet("127.0.0.1", INGRESS_PORT, domainA, 6000)).status);
        } catch {
          results.push(-1);
        }
        await sleep(50);
      }
    })();

    const result = await runServer(
      ["deploy", "--domain", domainA, "--", "python3", "-c", "import time; time.sleep(600)"],
      { env, stdin: appArchive(pythonApp("never-answers")) },
    );
    stop = true;
    await hammer;
    expect(result.code).not.toBe(0);
    expect(result.events.some((e) => e.event === "error")).toBe(true);

    // Every request during the failing deploy was answered 200 — no 5xx, no drop.
    expect(results.length).toBeGreaterThan(20);
    expect(results.every((status) => status === 200)).toBe(true);

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

    // Nothing live: no unit left behind, no release kept.
    expect(appUnits(domain).length).toBe(0);
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

  test("writable state in STATE_DIR survives a redeploy", async () => {
    // The app writes a marker into $STATE_DIR on first boot and serves it: if
    // the marker written by v1 is still served after deploying v2, state
    // lives outside the release dirs and survives cutovers (spec #20 story
    // 23 / #29).
    const stateApp = (version: string) => ({
      "version.txt": version,
      "server.py": `import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MARKER = os.path.join(os.environ["STATE_DIR"], "marker")
if not os.path.exists(MARKER):
    with open(MARKER, "w") as f:
        f.write("state-written-by-" + open("version.txt").read().strip())

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        with open(MARKER, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

ThreadingHTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
`,
    });

    const first = await runServer(["deploy", "--domain", domainState, ...RUN_PYTHON], {
      env,
      stdin: appArchive(stateApp("v1")),
    });
    expect(first.code).toBe(0);
    expect((await httpGet("127.0.0.1", INGRESS_PORT, domainState)).raw).toContain(
      "state-written-by-v1",
    );

    const second = await runServer(["deploy", "--domain", domainState, ...RUN_PYTHON], {
      env,
      stdin: appArchive(stateApp("v2")),
    });
    expect(second.code).toBe(0);
    expect((await httpGet("127.0.0.1", INGRESS_PORT, domainState)).raw).toContain(
      "state-written-by-v1",
    );
  });
});
