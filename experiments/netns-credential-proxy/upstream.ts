// PROTOTYPE — throwaway. The "internet": third-party APIs the sandboxed app
// wants to reach. Real TLS on :443, multi-host by the Host header (for the
// proxy's http->TLS origination path) and by SNI (for the CONNECT tunnel path).
//
// Hosts (all resolve to 203.0.113.x via the /etc/hosts overlay run.sh installs):
//   weather.test  — paid API. GET /api REQUIRES a Bearer token; 401 without.
//                   Echoes which principal it saw (authed_as) so we can tell an
//                   injected M2M token from a passed-through user token.
//   unknown.test  — a routable API we hold NO credential for. GET /api always
//                   200, echoes exactly what Authorization arrived (or null).
//   secure.test   — only spoken to over end-to-end https:// (CONNECT tunnel).
//                   GET /data reports what auth it saw — proves the proxy never
//                   injected anything into the opaque tunnel.
//
// Plus a tiny UDP :53 responder so the fail-closed demo can show DNS is the one
// sanctioned exception to the egress lockdown.

const CERT = process.env.CERT!;
const KEY = process.env.KEY!;

function tail(v: string | null): string | null {
  if (!v) return null;
  return "…" + v.slice(-10);
}

Bun.serve({
  port: 443,
  hostname: "0.0.0.0",
  tls: { cert: Bun.file(CERT), key: Bun.file(KEY) },
  fetch(req) {
    const url = new URL(req.url);
    const host = (req.headers.get("host") ?? url.hostname).split(":")[0];
    const auth = req.headers.get("authorization");
    console.error(`[upstream ${host}] ${req.method} ${url.pathname} auth=${tail(auth) ?? "none"}`);

    if (host === "weather.test") {
      if (url.pathname !== "/api") return new Response("not found\n", { status: 404 });
      if (!auth) {
        return new Response(JSON.stringify({ error: "unauthorized" }) + "\n", {
          status: 401,
          headers: { "www-authenticate": "Bearer", "content-type": "application/json" },
        });
      }
      return Response.json({ host, ok: true, authed_as: tail(auth), forecast: "sunny" });
    }

    if (host === "unknown.test") {
      // Always answers, and tells us exactly what auth arrived — so a missing
      // credential is visible as got_auth: null.
      return Response.json({ host, got_auth: tail(auth) });
    }

    if (host === "secure.test") {
      // Reached only through an end-to-end TLS tunnel; the proxy is blind here.
      return Response.json({ host, secured: true, saw_auth: tail(auth) });
    }

    return new Response("unknown host\n", { status: 421 });
  },
});
console.error(`[upstream] HTTPS listening on 0.0.0.0:443 (weather.test / unknown.test / secure.test)`);

// DNS-exception stand-in: a UDP responder on the proxy's gateway IP:53. The
// locked-down app netns permits udp/53 out and nothing else, so a datagram here
// getting a reply demonstrates DNS is the sole sanctioned exception.
Bun.udpSocket({
  port: 53,
  hostname: "10.0.0.1",
  socket: {
    data(socket, _buf, port, addr) {
      socket.send("DNS-REPLY-OK\n", port, addr);
    },
  },
}).then(() => console.error("[upstream] UDP :53 responder on 10.0.0.1"));
