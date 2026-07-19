import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Release name for `date`, unique among `existing` (ADR 0005: timestamp only,
 * same-second collisions suffixed `-<n>`).
 */
export function releaseNameFor(date: Date, existing: string[]): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const base =
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function appDir(appsDir: string, domain: string): string {
  return join(appsDir, domain);
}

export function deploymentsDir(appsDir: string, domain: string): string {
  return join(appDir(appsDir, domain), "deployments");
}

/**
 * The app's writable state dir (#29): stable across releases, outside every
 * release dir, handed to the app as STATE_DIR. Anything written elsewhere is
 * orphaned by the next deploy.
 */
export function ensureStateDir(appsDir: string, domain: string): string {
  const dir = join(appDir(appsDir, domain), "state");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function listReleases(appsDir: string, domain: string): string[] {
  const dir = deploymentsDir(appsDir, domain);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

/** Name of the release `current` points at, or null before the first cutover. */
export function currentRelease(appsDir: string, domain: string): string | null {
  const link = join(appDir(appsDir, domain), "current");
  try {
    return basename(readlinkSync(link));
  } catch {
    return null;
  }
}

/** Atomically point `current` at a release (symlink to temp name + rename). */
export function swapCurrent(appsDir: string, domain: string, release: string): void {
  const dir = appDir(appsDir, domain);
  const tmp = join(dir, ".current.tmp");
  symlinkSync(join("deployments", release), tmp);
  renameSync(tmp, join(dir, "current"));
}

export function listApps(appsDir: string): string[] {
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir).sort();
}

export function newReleaseDir(appsDir: string, domain: string, date = new Date()): { name: string; dir: string } {
  const name = releaseNameFor(date, listReleases(appsDir, domain));
  const dir = join(deploymentsDir(appsDir, domain), name);
  mkdirSync(dir, { recursive: true });
  return { name, dir };
}
