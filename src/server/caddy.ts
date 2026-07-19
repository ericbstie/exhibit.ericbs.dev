/**
 * Host routing through the Caddy admin API (ADR 0003): exhibit owns one HTTP
 * server (`apps.http.servers.exhibit`) and one route per domain, applied via
 * `localhost:2019` — atomic, zero-downtime.
 *
 * Deliberate R1 scope-down (spec #20): ADR 0003 makes Caddy the single TLS
 * terminator with eager per-domain HTTP-01 certs, but TLS is deferred to its
 * own release — this configures plaintext HTTP Host routing only.
 */
import type { Target } from "./net.ts";
import { targetString } from "./net.ts";

function routeId(domain: string): string {
  return `exhibit-route-${domain}`;
}

/**
 * The cutover itself never routes at a dead upstream — a release only becomes
 * the route target after VERIFY, while the outgoing release keeps serving
 * (#28). The retry buffer is defense in depth for the remaining gap: an app
 * that crashes and is being restarted by systemd.
 */
function routeFor(domain: string, target: Target): object {
  return {
    "@id": routeId(domain),
    match: [{ host: [domain] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: targetString(target) }],
        load_balancing: { try_duration: "5s", try_interval: "250ms" },
      },
    ],
    terminal: true,
  };
}

async function api(
  admin: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${admin}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function mustApi(admin: string, method: string, path: string, body?: unknown): Promise<void> {
  const res = await api(admin, method, path, body);
  if (!res.ok) {
    throw new Error(`caddy ${method} ${path} → ${res.status}: ${await res.text()}`);
  }
}

/**
 * Ensure the exhibit HTTP server exists in Caddy's config, creating only the
 * missing level — never replacing config Exhibit doesn't own. A full `/load`
 * happens only when Caddy has no config at all.
 */
export async function ensureExhibitServer(admin: string, listen: string): Promise<void> {
  const cfgRes = await api(admin, "GET", "/config/");
  const cfg = cfgRes.ok ? await cfgRes.json() : null;
  if (cfg?.apps?.http?.servers?.exhibit) return;
  const exhibit = { listen: [listen], routes: [] };
  if (!cfg) {
    await mustApi(admin, "POST", "/load", {
      admin: { listen: new URL(admin).host },
      apps: { http: { servers: { exhibit } } },
    });
  } else if (!cfg.apps) {
    await mustApi(admin, "PUT", "/config/apps", { http: { servers: { exhibit } } });
  } else if (!cfg.apps.http) {
    await mustApi(admin, "PUT", "/config/apps/http", { servers: { exhibit } });
  } else if (!cfg.apps.http.servers) {
    await mustApi(admin, "PUT", "/config/apps/http/servers", { exhibit });
  } else {
    await mustApi(admin, "PUT", "/config/apps/http/servers/exhibit", exhibit);
  }
}

/** Install or replace the route for a domain — no downtime on replace. */
export async function upsertRoute(
  admin: string,
  listen: string,
  domain: string,
  target: Target,
): Promise<void> {
  await ensureExhibitServer(admin, listen);
  const route = routeFor(domain, target);
  const existing = await api(admin, "GET", `/id/${routeId(domain)}`);
  if (existing.ok) {
    await mustApi(admin, "PATCH", `/id/${routeId(domain)}`, route);
  } else {
    await mustApi(admin, "POST", "/config/apps/http/servers/exhibit/routes", route);
  }
}
