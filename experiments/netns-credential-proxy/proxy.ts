// PROTOTYPE — throwaway. The transparent credential proxy (ADR 0001, model (a):
// plaintext-to-proxy + TLS origination). Runs in the GATEWAY netns; it is the
// app netns's only sanctioned exit. Implemented as a raw TCP forward proxy so
// it can serve both request shapes an HTTP_PROXY-respecting client emits:
//
//   http://  ->  absolute-URI request, readable in plaintext. If the host is a
//                declared upstream AND the app sent no Authorization of its own,
//                attach the per-domain M2M credential, then ORIGINATE REAL TLS
//                to the upstream on :443. Plaintext never leaves the host.
//
//   https:// ->  opaque `CONNECT host:443` tunnel. Bytes are relayed blind; the
//                proxy cannot and does not inject a credential. Thin-logged only.
//                This is the documented limit: https:// = you own the auth.
//
// Enforcement note: HTTP_PROXY is only the cooperative fast path. The *guarantee*
// that an app cannot reach the internet another way is the netns fail-closed
// rule (see run.sh); this proxy assumes that floor and does not police it.

import { M2M_SET, APP_BY_SRC_IP } from "./config";

const LISTEN_HOST = process.env.PROXY_HOST ?? "10.0.0.1";
const LISTEN_PORT = Number(process.env.PROXY_PORT ?? 3128);
const LOG = process.env.PROXY_LOG; // append metadata log lines here (JSON)

const HOP_BY_HOP = new Set([
  "proxy-connection", "connection", "keep-alive", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function appFor(socket: any): string {
  return APP_BY_SRC_IP[socket.remoteAddress] ?? socket.remoteAddress ?? "unknown";
}

// Metadata-only audit log. NEVER receives the credential value — only whether
// one was attached. Emitted per flow to stderr and (if set) the log file.
function audit(line: Record<string, unknown>) {
  const s = JSON.stringify({ ts: new Date().toISOString(), ...line });
  console.error("[audit] " + s);
  if (LOG) Bun.write(LOG, s + "\n", { createPath: true }).catch(() => {});
}

// A pending write buffer — coarse, no backpressure handling (PoC payloads are tiny).
type State = {
  phase: "reading" | "tunnel" | "done";
  buf: Buffer;
  app: string;
  upstreamSock?: any; // the connected upstream socket (set on open)
  aToB: number; // app -> upstream bytes (tunnel)
  bToA: number; // upstream -> app bytes (tunnel)
  start: number;
  dstHost?: string;
};

async function handleHttp(socket: any, st: State, reqLine: string, headerLines: string[]) {
  const [method, target] = reqLine.split(" ");
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
    return;
  }
  const host = url.hostname;
  const path = url.pathname + url.search;
  st.dstHost = host;

  const headers = new Headers();
  for (const l of headerLines) {
    const i = l.indexOf(":");
    if (i < 0) continue;
    const k = l.slice(0, i).trim().toLowerCase();
    const v = l.slice(i + 1).trim();
    if (HOP_BY_HOP.has(k)) continue;
    headers.set(k, v);
  }

  const appHasAuth = headers.has("authorization");
  const declared = host in M2M_SET;
  // Attach the service credential only for a declared upstream when the app has
  // no Authorization of its own (never-overwrite). Everything else: no cred.
  let credAttached = false;
  if (declared && !appHasAuth) {
    headers.set("authorization", M2M_SET[host].credential);
    credAttached = true;
  }

  let status = 0;
  let bytes = 0;
  try {
    // Originate REAL TLS to the upstream on :443. NODE_EXTRA_CA_CERTS trusts the
    // PoC CA; the host resolves (via /etc/hosts overlay) to 203.0.113.x and the
    // cert's SAN is validated against `host`.
    const res = await fetch(`https://${host}${path}`, { method, headers });
    const body = Buffer.from(await res.arrayBuffer());
    status = res.status;
    bytes = body.length;
    const head =
      `HTTP/1.1 ${res.status} ${res.statusText || ""}\r\n` +
      `content-type: ${res.headers.get("content-type") ?? "application/octet-stream"}\r\n` +
      `content-length: ${body.length}\r\n` +
      `connection: close\r\n\r\n`;
    socket.write(Buffer.from(head, "latin1"));
    socket.write(body);
    socket.end();
  } catch (err) {
    socket.end(`HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n`);
    status = 502;
  }
  st.phase = "done";
  // Credentialed-flow metadata. Note: cred_attached is a boolean — the token
  // value is never logged.
  audit({ app: st.app, dst_host: host, method, path, status, bytes, cred_attached: credAttached });
}

function startTunnel(socket: any, st: State, target: string, leftover: Buffer) {
  const [host, portStr] = target.split(":");
  const port = Number(portStr || 443);
  st.dstHost = host;
  // Bun.connect returns a Promise<Socket>; the live socket arrives in open().
  Bun.connect({
    hostname: host,
    port,
    socket: {
      open(u) {
        st.upstreamSock = u;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        st.phase = "tunnel";
        if (leftover.length) {
          st.aToB += leftover.length;
          u.write(leftover);
        }
      },
      data(_u, chunk) {
        st.bToA += chunk.length;
        socket.write(chunk);
      },
      close() { socket.end(); },
      error() { socket.end(); },
    },
  });
}

Bun.listen({
  hostname: LISTEN_HOST,
  port: LISTEN_PORT,
  socket: {
    open(socket) {
      socket.data = {
        phase: "reading", buf: Buffer.alloc(0), app: appFor(socket),
        aToB: 0, bToA: 0, start: Date.now(),
      } as State;
    },
    data(socket, chunk) {
      const st = socket.data as State;
      if (st.phase === "tunnel") {
        st.aToB += chunk.length;
        st.upstreamSock?.write(chunk);
        return;
      }
      if (st.phase !== "reading") return;
      st.buf = Buffer.concat([st.buf, chunk]);
      const end = st.buf.indexOf("\r\n\r\n");
      if (end < 0) return; // headers not complete yet
      const headerBlock = st.buf.slice(0, end).toString("latin1");
      const leftover = st.buf.slice(end + 4);
      const [reqLine, ...headerLines] = headerBlock.split("\r\n");
      const method = reqLine.split(" ")[0];
      if (method === "CONNECT") {
        const target = reqLine.split(" ")[1];
        startTunnel(socket, st, target, leftover);
      } else {
        st.phase = "handling" as any;
        handleHttp(socket, st, reqLine, headerLines);
      }
    },
    close(socket) {
      const st = socket.data as State | undefined;
      if (!st) return;
      st.upstreamSock?.end?.();
      // Opaque-tunnel (https://) thin log: dst host, byte counts, duration. No
      // method/path/status — the proxy never saw them — and never a credential.
      if (st.dstHost && (st.aToB > 0 || st.bToA > 0) && st.phase === "tunnel") {
        audit({
          app: st.app, dst_host: st.dstHost, tunnelled: true,
          bytes_app_to_upstream: st.aToB, bytes_upstream_to_app: st.bToA,
          duration_ms: Date.now() - st.start,
        });
      }
    },
    error(socket) { (socket.data as State)?.upstreamSock?.end?.(); },
  },
});

console.error(`[proxy] credential proxy on ${LISTEN_HOST}:${LISTEN_PORT}  declared upstreams: ${Object.keys(M2M_SET).join(", ")}`);
