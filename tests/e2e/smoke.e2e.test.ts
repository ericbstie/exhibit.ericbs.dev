import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { CADDY_ADMIN, E2E } from "./harness.ts";

// T1 (#22): prove the harness itself — systemd reaches `active` for a fixture
// unit, the Caddy admin API answers, and mise is present — before any deploy
// logic depends on it.
describe.skipIf(!E2E)("e2e harness smoke", () => {
  const unitPath = "/etc/systemd/system/exhibit-smoke.service";

  afterAll(() => {
    Bun.spawnSync(["systemctl", "disable", "--now", "exhibit-smoke.service"]);
    try {
      unlinkSync(unitPath);
    } catch {}
    Bun.spawnSync(["systemctl", "daemon-reload"]);
  });

  test("a fixture systemd unit reaches active", async () => {
    writeFileSync(
      unitPath,
      "[Unit]\nDescription=Exhibit harness smoke\n\n[Service]\nExecStart=/bin/sleep 300\n",
    );
    expect(Bun.spawnSync(["systemctl", "daemon-reload"]).exitCode).toBe(0);
    expect(Bun.spawnSync(["systemctl", "start", "exhibit-smoke.service"]).exitCode).toBe(0);
    const state = Bun.spawnSync(["systemctl", "is-active", "exhibit-smoke.service"]);
    expect(state.stdout.toString().trim()).toBe("active");
  });

  test("the Caddy admin API answers", async () => {
    const res = await fetch(`${CADDY_ADMIN}/config/`);
    expect(res.ok).toBe(true);
  });

  test("mise is available", () => {
    expect(Bun.spawnSync(["mise", "--version"]).exitCode).toBe(0);
  });
});
