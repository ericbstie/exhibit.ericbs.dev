import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listApps } from "./releases.ts";

/**
 * The address seam (spec #20): the router target is *read* from per-app state,
 * never derived inline. R1 records a localhost port in
 * `apps/<domain>/.exhibit/net.toml`; a later sandbox release records a veth IP
 * there instead, with no change to deploy or ingress.
 */
export interface Target {
  host: string;
  port: number;
}

function netTomlPath(appsDir: string, domain: string): string {
  return join(appsDir, domain, ".exhibit", "net.toml");
}

export function readRecordedPort(appsDir: string, domain: string): number | null {
  const path = netTomlPath(appsDir, domain);
  if (!existsSync(path)) return null;
  const match = readFileSync(path, "utf8").match(/^\s*port\s*=\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

/** True when nothing is listening on 127.0.0.1:port. */
async function bindProbe(port: number): Promise<boolean> {
  try {
    const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    listener.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lowest free port ≥ base: a single-writer scan of every app's
 * `.exhibit/net.toml` — no lock, no registry (ADR 0005). `probe` additionally
 * skips ports some unrelated process already occupies.
 *
 * Concurrent deploys can race this scan: an in-flight release's port is
 * unrecorded until cutover and unbound until its app boots. Accepted for R1
 * (single operator, deploys unserialized — ADR 0005 amendment); the exhibitd
 * split (ADR 0002) is where serialization lands.
 */
export async function allocatePort(
  appsDir: string,
  base: number,
  probe: (port: number) => Promise<boolean> = bindProbe,
): Promise<number> {
  const used = new Set<number>();
  for (const domain of listApps(appsDir)) {
    const port = readRecordedPort(appsDir, domain);
    if (port !== null) used.add(port);
  }
  for (let candidate = base; candidate < 65536; candidate++) {
    if (!used.has(candidate) && (await probe(candidate))) return candidate;
  }
  throw new Error(`no free port at or above ${base}`);
}

/**
 * Record a port as the app's live target. Written only at cutover: until a
 * release passes VERIFY, its port stays unrecorded, so the route and `ls`
 * keep pointing at the release that is actually serving (#28).
 */
export function recordPort(appsDir: string, domain: string, port: number): void {
  mkdirSync(join(appsDir, domain, ".exhibit"), { recursive: true });
  writeFileSync(netTomlPath(appsDir, domain), `port = ${port}\n`);
}

/** `resolveTarget(domain) → host:port`, backed by `.exhibit/net.toml`. */
export function resolveTarget(appsDir: string, domain: string): Target | null {
  const port = readRecordedPort(appsDir, domain);
  return port === null ? null : { host: "127.0.0.1", port };
}

export function targetString(target: Target): string {
  return `${target.host}:${target.port}`;
}
