/**
 * Shared harness for the end-to-end suite (spec #20: the single highest test
 * seam). These tests need a real Linux environment with systemd, Caddy (admin
 * API on localhost:2019), and mise — CI provides it; locally they only run
 * when EXHIBIT_E2E=1 is set.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployEvent } from "../../src/server/events.ts";

export const E2E = process.env.EXHIBIT_E2E === "1";
/** The T5 suite additionally needs the loopback sshd CI configures. */
export const SSH_E2E = E2E && process.env.EXHIBIT_SSH_E2E === "1";

export const CADDY_ADMIN = "http://127.0.0.1:2019";
export const INGRESS_PORT = 80;

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** A fresh isolated EXHIBIT_ROOT; distinct port bases keep suites collision-free. */
export function freshServerEnv(suite: string, portBase: number): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), `exhibit-${suite}-`));
  return {
    EXHIBIT_ROOT: root,
    EXHIBIT_PORT_BASE: String(portBase),
    EXHIBIT_VERIFY_TIMEOUT_MS: "8000",
  };
}

export interface ServerRun {
  code: number;
  stdout: string;
  stderr: string;
  events: DeployEvent[];
}

/** Run `exhibit-server <args>` from source, optionally with an archive on stdin. */
export async function runServer(
  args: string[],
  opts: { env?: Record<string, string>; stdin?: Uint8Array } = {},
): Promise<ServerRun> {
  const proc = Bun.spawn(["bun", join(REPO_ROOT, "src", "server", "main.ts"), ...args], {
    env: { ...process.env, ...opts.env },
    stdin: opts.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const events: DeployEvent[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // non-NDJSON output shows up in `stdout` for the test to inspect
    }
  }
  return { code, stdout, stderr, events };
}

/** Tar up a fixture app dir, as `git archive HEAD` would deliver it. */
export function appArchive(files: Record<string, string>): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "exhibit-fixture-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const tar = Bun.spawnSync(["tar", "-C", dir, "-cf", "-", "."], { stdout: "pipe" });
  if (tar.exitCode !== 0) throw new Error("fixture tar failed");
  return new Uint8Array(tar.stdout);
}

/** A trivial HTTP app that serves `body.txt` (or "hello") on $PORT. */
export const PYTHON_SERVER = `import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            with open("body.txt", "rb") as f:
                body = f.read()
        except FileNotFoundError:
            body = b"hello"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

ThreadingHTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
`;

export function pythonApp(body: string): Record<string, string> {
  return { "server.py": PYTHON_SERVER, "body.txt": body };
}

export const RUN_PYTHON = ["--", "python3", "server.py"];

/** Reset Caddy to an empty config so each suite starts from a known state. */
export async function resetCaddy(): Promise<void> {
  const res = await fetch(`${CADDY_ADMIN}/load`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      admin: { listen: "localhost:2019" },
      apps: { http: { servers: {} } },
    }),
  });
  if (!res.ok) throw new Error(`caddy reset failed: ${res.status} ${await res.text()}`);
}

/** Every existing unit of a domain (one instance per release since #28). */
export function appUnits(domain: string): string[] {
  const units = new Set<string>();
  for (const list of [["list-units", "--all"], ["list-unit-files"]]) {
    const found = Bun.spawnSync([
      "systemctl",
      ...list,
      "--plain",
      "--no-legend",
      "--no-pager",
      `exhibit-app@${domain}_*.service`,
    ]);
    for (const line of found.stdout.toString().split("\n")) {
      const unit = line.trim().split(/\s+/)[0];
      if (unit?.startsWith("exhibit-app@")) units.add(unit);
    }
  }
  return [...units];
}

/** Best-effort teardown of an app's units + drop-ins between suites. */
export async function cleanupApp(domain: string): Promise<void> {
  for (const unit of appUnits(domain)) {
    Bun.spawnSync(["systemctl", "disable", "--now", unit]);
    Bun.spawnSync(["systemctl", "reset-failed", unit]);
  }
  Bun.spawnSync(["bash", "-c", `rm -rf '/etc/systemd/system/exhibit-app@${domain}'_*.service.d`]);
  Bun.spawnSync(["systemctl", "daemon-reload"]);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parse the target port for a domain out of `exhibit-server ls` output. */
export function portFromLs(lsOutput: string, domain: string): number {
  const line = lsOutput.split("\n").find((l) => l.startsWith(domain));
  const match = line?.match(/127\.0\.0\.1:(\d+)/);
  if (!match) throw new Error(`no target for ${domain} in:\n${lsOutput}`);
  return Number(match[1]);
}
