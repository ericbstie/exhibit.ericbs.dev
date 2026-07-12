// Auth-injecting transparent proxy. Runs INSIDE the network namespace.
//
// iptables REDIRECTs the client's outbound :1234 traffic here (:8888). We add
// the Basic auth header the client never sent, then forward to the real
// weather API. The client stays oblivious; credentials live only here, at the
// namespace boundary.
//
// The proxy's own forwarding connection to the real API must NOT be redirected
// back into itself. That is handled in the netns script with an iptables
// `owner --uid-owner` RETURN rule matching the uid this process runs as.

const PORT = 8888;
const REAL_API = process.env.REAL_API ?? "http://10.200.1.1:1234";
const USER = process.env.INJECT_USER ?? "acme";
const PASS = process.env.INJECT_PASS ?? "s3cr3t";
const AUTH = "Basic " + btoa(`${USER}:${PASS}`);

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const target = `${REAL_API}${url.pathname}${url.search}`;

    // Clone incoming headers and inject auth.
    const headers = new Headers(req.headers);
    headers.set("authorization", AUTH);
    headers.set("x-intercepted-by", "netns-interceptor");

    console.log(`[interceptor] ${req.method} ${url.pathname} -> injecting auth, forwarding to ${target}`);

    const res = await fetch(target, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    });

    const body = await res.arrayBuffer();
    return new Response(body, { status: res.status, headers: res.headers });
  },
});

console.log(`[interceptor] listening on :${PORT}  -> real API ${REAL_API}  (injecting user=${USER})`);
