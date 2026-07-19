import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { httpGet } from "../../src/server/http.ts";
import {
  appArchive,
  appUnits,
  cleanupApp,
  E2E,
  freshServerEnv,
  portFromLs,
  pythonApp,
  resetCaddy,
  runServer,
  RUN_PYTHON,
} from "./harness.ts";

// T2 (#23): a deployed app runs under systemd on an allocated local port,
// reachable through the resolved target; two apps get distinct ports.
// Assertions stay on observable behavior — the resolved target reported by
// `ls`, HTTP responses, unit state — never on internal file layout (#30).
describe.skipIf(!E2E)("run under systemd on an allocated port", () => {
  const env = freshServerEnv("t2", 4200);
  const domainA = "t2-a.test";
  const domainB = "t2-b.test";

  beforeAll(resetCaddy);
  afterAll(async () => {
    await cleanupApp(domainA);
    await cleanupApp(domainB);
  });

  test("the app answers HTTP on its allocated port; unit active and enabled", async () => {
    const result = await runServer(["deploy", "--domain", domainA, ...RUN_PYTHON], {
      env,
      stdin: appArchive(pythonApp("t2-a v1")),
    });
    expect(result.code).toBe(0);

    const ls = await runServer(["ls"], { env });
    const port = portFromLs(ls.stdout, domainA);
    const direct = await httpGet("127.0.0.1", port, domainA);
    expect(direct.status).toBe(200);
    expect(direct.raw).toContain("t2-a v1");

    // Exactly one instance serves the domain, active and enabled for reboot.
    const units = appUnits(domainA);
    expect(units.length).toBe(1);
    expect(Bun.spawnSync(["systemctl", "is-active", units[0]!]).stdout.toString().trim()).toBe(
      "active",
    );
    expect(Bun.spawnSync(["systemctl", "is-enabled", units[0]!]).stdout.toString().trim()).toBe(
      "enabled",
    );
  });

  test("after a redeploy the resolved target serves the new release", async () => {
    const redeploy = await runServer(["deploy", "--domain", domainA, ...RUN_PYTHON], {
      env,
      stdin: appArchive(pythonApp("t2-a v2")),
    });
    expect(redeploy.code).toBe(0);

    // The target `ls` reports is where the app actually answers — the address
    // seam holds regardless of which port this release landed on (#28 gives
    // every release its own port, so we assert reachability, not stability).
    const port = portFromLs((await runServer(["ls"], { env })).stdout, domainA);
    const direct = await httpGet("127.0.0.1", port, domainA);
    expect(direct.status).toBe(200);
    expect(direct.raw).toContain("t2-a v2");

    // The outgoing release's instance was decommissioned — one unit remains.
    expect(appUnits(domainA).length).toBe(1);
  });

  test("two apps get distinct ports with no collision", async () => {
    const result = await runServer(["deploy", "--domain", domainB, ...RUN_PYTHON], {
      env,
      stdin: appArchive(pythonApp("t2-b v1")),
    });
    expect(result.code).toBe(0);

    const ls = await runServer(["ls"], { env });
    const portA = portFromLs(ls.stdout, domainA);
    const portB = portFromLs(ls.stdout, domainB);
    expect(portB).not.toBe(portA);
    const direct = await httpGet("127.0.0.1", portB, domainB);
    expect(direct.raw).toContain("t2-b v1");
  });
});
