import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocatePort } from "../src/server/net.ts";

// Spec (ADR 0005 / T2): port allocation is a single-writer lowest-free scan of
// apps/*/.exhibit/net.toml — no lock, no registry.
function appsDirWith(ports: Record<string, number>): string {
  const appsDir = mkdtempSync(join(tmpdir(), "exhibit-ports-"));
  for (const [domain, port] of Object.entries(ports)) {
    const stateDir = join(appsDir, domain, ".exhibit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "net.toml"), `port = ${port}\n`);
  }
  return appsDir;
}

const alwaysFree = async () => true;

describe("allocatePort", () => {
  test("returns the base port for an empty apps dir", async () => {
    const appsDir = appsDirWith({});
    expect(await allocatePort(appsDir, 4100, alwaysFree)).toBe(4100);
  });

  test("skips ports recorded in any app's net.toml", async () => {
    const appsDir = appsDirWith({ "a.test": 4100, "b.test": 4101 });
    expect(await allocatePort(appsDir, 4100, alwaysFree)).toBe(4102);
  });

  test("fills the lowest gap between recorded ports", async () => {
    const appsDir = appsDirWith({ "a.test": 4100, "c.test": 4102 });
    expect(await allocatePort(appsDir, 4100, alwaysFree)).toBe(4101);
  });

  test("skips ports the probe reports as occupied", async () => {
    const appsDir = appsDirWith({ "a.test": 4100 });
    const probe = async (port: number) => port !== 4101;
    expect(await allocatePort(appsDir, 4100, probe)).toBe(4102);
  });
});
