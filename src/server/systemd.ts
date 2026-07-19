import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHELL_SAFE_WORD } from "../shared/words.ts";
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

/**
 * One systemd instance per release — `<domain>_<release>` — so a new release
 * can run and VERIFY beside the live one and the cutover is a route swap, not
 * a restart (#28). `_` cannot appear in a domain (see `validateDomain`), so
 * the split is unambiguous.
 */
export function instanceId(domain: string, release: string): string {
  return `${domain}_${release}`;
}

export function unitName(instance: string): string {
  return `exhibit-app@${instance}.service`;
}

/** Glob matching every release-instance of a domain (systemctl/journalctl accept globs). */
export function unitPattern(domain: string): string {
  return `exhibit-app@${domain}_*.service`;
}

function dropInDir(unitDir: string, instance: string): string {
  return join(unitDir, `${unitName(instance)}.d`);
}

function dropInPath(unitDir: string, instance: string): string {
  return join(dropInDir(unitDir, instance), "50-exhibit.conf");
}

/** systemd unquoting is shell-like; quote any arg that needs it. */
function quoteExecArg(arg: string): string {
  if (SHELL_SAFE_WORD.test(arg)) return arg;
  return `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Deliberate deviation from ADR 0002's snippet (`WorkingDirectory=…/current`):
 * the drop-in points at the concrete release dir because each release is its
 * own instance, started and VERIFYed while the previous release keeps serving
 * (#28). `current` remains the derived source of truth for `ls`/rollback
 * (ADR 0005). STATE_DIR realizes the writable-state contract (#29): a stable
 * per-app dir outside every release dir, surviving redeploys.
 */
export function renderDropIn(opts: {
  releaseDir: string;
  port: number;
  stateDir: string;
  runCmd: string[];
}): string {
  const exec = ["/usr/bin/env", ...opts.runCmd].map(quoteExecArg).join(" ");
  return `[Service]
WorkingDirectory=${opts.releaseDir}
Environment=PORT=${opts.port}
Environment=STATE_DIR=${opts.stateDir}
Environment=MISE_TRUSTED_CONFIG_PATHS=${opts.releaseDir}
ExecStart=
ExecStart=${exec}
`;
}

/** Install the shared template if missing or stale. */
export function installTemplate(unitDir: string): void {
  const path = join(unitDir, "exhibit-app@.service");
  if (existsSync(path) && readFileSync(path, "utf8") === TEMPLATE) return;
  writeFileSync(path, TEMPLATE);
}

export function writeDropIn(unitDir: string, instance: string, content: string): void {
  mkdirSync(dropInDir(unitDir, instance), { recursive: true });
  writeFileSync(dropInPath(unitDir, instance), content);
}

export function removeDropIn(unitDir: string, instance: string): void {
  rmSync(dropInDir(unitDir, instance), { recursive: true, force: true });
}

export async function systemctl(...args: string[]): Promise<void> {
  await mustRun(["systemctl", ...args]);
}

/** `systemctl is-active` state (e.g. "active", "activating", "failed"). */
export async function unitState(instance: string): Promise<string> {
  const { stdout } = await run(["systemctl", "is-active", unitName(instance)]);
  return stdout.trim() || "unknown";
}

/** Reload units and start a release's instance, enabled for reboot. */
export async function startInstance(instance: string): Promise<void> {
  await systemctl("daemon-reload");
  await systemctl("enable", unitName(instance));
  await systemctl("restart", unitName(instance));
}

/** Take a release's instance out of service entirely: stop, un-enable, drop config. */
export async function retireInstance(unitDir: string, instance: string): Promise<void> {
  await run(["systemctl", "disable", "--now", unitName(instance)]);
  await run(["systemctl", "reset-failed", unitName(instance)]);
  removeDropIn(unitDir, instance);
  await run(["systemctl", "daemon-reload"]);
}

/**
 * Every existing instance of a domain — running or merely enabled — including
 * the bare `<domain>` instance the pre-#28 single-instance layout used. Feeds
 * the decommission sweep, so a crashed deploy's stray can't linger.
 */
export async function listInstances(domain: string): Promise<string[]> {
  const patterns = [unitPattern(domain), unitName(domain)];
  const instances = new Set<string>();
  for (const list of [["list-units", "--all"], ["list-unit-files"]]) {
    const { stdout } = await run([
      "systemctl",
      ...list,
      "--plain",
      "--no-legend",
      "--no-pager",
      ...patterns,
    ]);
    for (const line of stdout.split("\n")) {
      const unit = line.trim().split(/\s+/)[0];
      if (unit?.startsWith("exhibit-app@") && unit.endsWith(".service")) {
        instances.add(unit.slice("exhibit-app@".length, -".service".length));
      }
    }
  }
  return [...instances];
}

/** Tail one instance's log — precise, so a failure tail can't interleave the live release's. */
export async function journalTail(instance: string, lines: number): Promise<string> {
  const { stdout } = await run([
    "journalctl",
    "-u",
    unitName(instance),
    "-n",
    String(lines),
    "--no-pager",
    "-o",
    "cat",
  ]);
  return stdout;
}
