import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpGet } from "../../src/server/http.ts";
import {
  cleanupApp,
  INGRESS_PORT,
  PYTHON_SERVER,
  resetCaddy,
  SSH_E2E,
} from "./harness.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// T5 (#26): the ex CLI end to end over a real ssh round-trip. CI configures a
// loopback sshd whose `exhibit-e2e` host alias lands on exhibit-server as the
// forced command (ADR 0006) with EXHIBIT_ROOT=/srv/exhibit-e2e.
describe.skipIf(!SSH_E2E)("ex CLI over SSH", () => {
  const domain = "t5.test";
  const tmp = mkdtempSync(join(tmpdir(), "exhibit-t5-"));
  const configPath = join(tmp, "config.toml");
  const repo = join(tmp, "app");

  function runEx(
    args: string[],
    opts: { cwd?: string } = {},
  ): { code: number; stdout: string; stderr: string } {
    const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "src", "ex", "main.ts"), ...args], {
      cwd: opts.cwd ?? tmp,
      env: { ...process.env, EXHIBIT_CONFIG: configPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  }

  function git(...args: string[]): void {
    const proc = Bun.spawnSync(
      ["git", "-c", "user.email=e2e@exhibit.test", "-c", "user.name=e2e", ...args],
      { cwd: repo },
    );
    if (proc.exitCode !== 0) throw new Error(`git ${args[0]}: ${proc.stderr.toString()}`);
  }

  beforeAll(async () => {
    await resetCaddy();
    Bun.spawnSync(["mkdir", "-p", repo]);
    writeFileSync(join(repo, "server.py"), PYTHON_SERVER);
    writeFileSync(join(repo, "body.txt"), "t5-committed-v1");
    git("init");
    git("add", ".");
    git("commit", "-m", "v1");
  });
  afterAll(async () => {
    await cleanupApp(domain);
  });

  test("ex login records the server target", () => {
    const result = runEx(["login", "exhibit-e2e"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("exhibit-e2e");
  });

  test("ex deploy publishes the app: curl on the domain returns 200", async () => {
    const result = runEx(["deploy", "--domain", domain, "--", "python3", "server.py"], {
      cwd: repo,
    });
    expect(result.code).toBe(0);
    // Live per-step progress reached the terminal.
    expect(result.stdout).toContain("✓ unpack");
    expect(result.stdout).toContain("✓ verify");
    expect(result.stdout).toContain(`deployed ${domain}`);

    const res = await httpGet("127.0.0.1", INGRESS_PORT, domain);
    expect(res.status).toBe(200);
    expect(res.raw).toContain("t5-committed-v1");
  });

  test("a dirty working tree warns and ships committed content only", async () => {
    writeFileSync(join(repo, "body.txt"), "t5-uncommitted-v2");
    const result = runEx(["deploy", "--domain", domain, "--", "python3", "server.py"], {
      cwd: repo,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("dirty");
    // The uncommitted edit did not land in the release.
    const res = await httpGet("127.0.0.1", INGRESS_PORT, domain);
    expect(res.raw).toContain("t5-committed-v1");
  });

  test("ex ls shows releases and which is current", () => {
    const result = runEx(["ls"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(domain);
    expect(result.stdout).toMatch(/^\* \d{8}-\d{6}/m);
  });

  test("ex logs tails the app's journald output", () => {
    const result = runEx(["logs", domain, "-n", "5"]);
    expect(result.code).toBe(0);
  });

  test("a build failure surfaces its output and exits non-zero", () => {
    writeFileSync(
      join(repo, "mise.toml"),
      `[tasks.prepare]\nrun = "echo T5_BUILD_BROKEN && exit 1"\n`,
    );
    git("add", ".");
    git("commit", "-m", "broken build");
    const result = runEx(["deploy", "--domain", domain, "--", "python3", "server.py"], {
      cwd: repo,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("T5_BUILD_BROKEN");
  });
});
