import { join } from "node:path";

/** Server-side configuration, resolved from the environment with R1 defaults. */
export interface ServerEnv {
  /** Exhibit root on the VPS; apps live under `<root>/apps`. */
  root: string;
  appsDir: string;
  /** Lowest port the allocator will hand out. */
  portBase: number;
  /** Base URL of the Caddy admin API (ADR 0003). */
  caddyAdmin: string;
  /** Listen address of the exhibit HTTP server managed inside Caddy. */
  ingressListen: string;
  /** Local port implied by `ingressListen`, used for the confirm-live check. */
  ingressPort: number;
  verifyTimeoutMs: number;
  /** Where systemd units are installed. */
  unitDir: string;
}

export function serverEnv(env: Record<string, string | undefined> = process.env): ServerEnv {
  const root = env.EXHIBIT_ROOT ?? "/srv/exhibit";
  const ingressListen = env.EXHIBIT_INGRESS_LISTEN ?? ":80";
  const ingressPort = Number(ingressListen.slice(ingressListen.lastIndexOf(":") + 1));
  return {
    root,
    appsDir: join(root, "apps"),
    portBase: Number(env.EXHIBIT_PORT_BASE ?? 4100),
    caddyAdmin: env.EXHIBIT_CADDY_ADMIN ?? "http://127.0.0.1:2019",
    ingressListen,
    ingressPort,
    verifyTimeoutMs: Number(env.EXHIBIT_VERIFY_TIMEOUT_MS ?? 30_000),
    unitDir: env.EXHIBIT_UNIT_DIR ?? "/etc/systemd/system",
  };
}

/** App domains double as directory and systemd instance names — keep them tame. */
export function validateDomain(domain: string): void {
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(domain) || domain.includes("..")) {
    throw new Error(`invalid domain: ${JSON.stringify(domain)}`);
  }
}
