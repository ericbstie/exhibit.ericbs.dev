import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mustRun, run } from "./exec.ts";

/**
 * The R1 unit: the ADR 0002 `exhibit-app@` template with all hardening
 * stripped (no DynamicUser / netns / ProtectSystem — those are the sandbox and
 * secrets releases). Per-app facts (working dir, PORT, run command) live in a
 * per-instance drop-in so the template stays one shared file.
 */
const TEMPLATE = `[Unit]
Description=Exhibit app %i

[Service]
Restart=on-failure
LogRateLimitIntervalSec=30
LogRateLimitBurst=100000

[Install]
WantedBy=multi-user.target
`;

export function unitName(domain: string): string {
  return `exhibit-app@${domain}.service`;
}

function dropInDir(unitDir: string, domain: string): string {
  return join(unitDir, `${unitName(domain)}.d`);
}

function dropInPath(unitDir: string, domain: string): string {
  return join(dropInDir(unitDir, domain), "50-exhibit.conf");
}

/** systemd unquoting is shell-like; quote any arg that needs it. */
function quoteExecArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderDropIn(opts: {
  releaseDir: string;
  port: number;
  runCmd: string[];
}): string {
  const exec = ["/usr/bin/env", ...opts.runCmd].map(quoteExecArg).join(" ");
  return `[Service]
WorkingDirectory=${opts.releaseDir}
Environment=PORT=${opts.port}
Environment=MISE_TRUSTED_CONFIG_PATHS=${opts.releaseDir}
ExecStart=
ExecStart=${exec}
`;
}

/** Install the shared template if missing or stale; returns whether it changed. */
export function installTemplate(unitDir: string): boolean {
  const path = join(unitDir, "exhibit-app@.service");
  if (existsSync(path) && readFileSync(path, "utf8") === TEMPLATE) return false;
  writeFileSync(path, TEMPLATE);
  return true;
}

export function readDropIn(unitDir: string, domain: string): string | null {
  const path = dropInPath(unitDir, domain);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function writeDropIn(unitDir: string, domain: string, content: string): void {
  mkdirSync(dropInDir(unitDir, domain), { recursive: true });
  writeFileSync(dropInPath(unitDir, domain), content);
}

export function removeDropIn(unitDir: string, domain: string): void {
  rmSync(dropInDir(unitDir, domain), { recursive: true, force: true });
}

export async function systemctl(...args: string[]): Promise<void> {
  await mustRun(["systemctl", ...args]);
}

/** `systemctl is-active` state (e.g. "active", "activating", "failed"). */
export async function unitState(domain: string): Promise<string> {
  const { stdout } = await run(["systemctl", "is-active", unitName(domain)]);
  return stdout.trim() || "unknown";
}

/** Reload units and (re)start the app's instance, enabled for reboot. */
export async function startApp(domain: string): Promise<void> {
  await systemctl("daemon-reload");
  await systemctl("enable", unitName(domain));
  await systemctl("restart", unitName(domain));
}

export async function stopApp(unitDir: string, domain: string): Promise<void> {
  await run(["systemctl", "disable", "--now", unitName(domain)]);
  await run(["systemctl", "reset-failed", unitName(domain)]);
  removeDropIn(unitDir, domain);
  await run(["systemctl", "daemon-reload"]);
}

export async function journalTail(domain: string, lines: number): Promise<string> {
  const { stdout } = await run([
    "journalctl",
    "-u",
    unitName(domain),
    "-n",
    String(lines),
    "--no-pager",
    "-o",
    "cat",
  ]);
  return stdout;
}
