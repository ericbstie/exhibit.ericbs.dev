import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { httpGet } from "../../src/server/http.ts";
import {
  appArchive,
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
// persisted in .exhibit/net.toml and reused on redeploy; two apps get
// distinct ports.
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

    const unit = `exhibit-app@${domainA}.service`;
    expect(Bun.spawnSync(["systemctl", "is-active", unit]).stdout.toString().trim()).toBe(
      "active",
    );
    expect(Bun.spawnSync(["systemctl", "is-enabled", unit]).stdout.toString().trim()).toBe(
      "enabled",
    );
  });

  test("the port is persisted and reused on redeploy of the same domain", async () => {
    const before = portFromLs((await runServer(["ls"], { env })).stdout, domainA);
    const redeploy = await runServer(["deploy", "--domain", domainA, ...RUN_PYTHON], {
      env,
      stdin: appArchive(pythonApp("t2-a v2")),
    });
    expect(redeploy.code).toBe(0);
    const after = portFromLs((await runServer(["ls"], { env })).stdout, domainA);
    expect(after).toBe(before);

    // The recorded fact lives in .exhibit/net.toml (ADR 0005).
    const netToml = readFileSync(
      join(env.EXHIBIT_ROOT!, "apps", domainA, ".exhibit", "net.toml"),
      "utf8",
    );
    expect(netToml).toContain(`port = ${after}`);
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
