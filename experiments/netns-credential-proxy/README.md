# PoC: transparent netns credential proxy

**Throwaway prototype** proving Exhibit issue
[#12](https://github.com/ericbstie/exhibit.ericbs.dev/issues/12) — the headline
de-risking proof for the core engine. It demonstrates the decided model,
**ADR 0001 model (a): plaintext-to-proxy + TLS origination** (forward-proxy
`HTTP_PROXY` transport, `http://`-only credential attachment, netns fail-closed
as the enforcement floor).

A sandboxed app that **holds no credential** reaches a paid API; the proxy
attaches the right per-domain credential at the network-namespace boundary and
originates real TLS to the upstream. An app that tries to bypass the proxy gets
no egress at all.

## Run it

```bash
./run.sh        # one command; needs bun, iproute2, iptables-nft, openssl
```

No host root required — it builds everything inside a rootless user namespace
(`unshare --user --map-root-user --net`). Prints `PASS`/`FAIL` per criterion and
exits non-zero if any check fails.

## Topology

```
GATEWAY netns                                     APP netns
┌────────────────────────────────────────┐       ┌───────────────────────┐
│ upstream HTTPS :443 (real TLS)          │       │ app (client.ts)       │
│   weather.test 203.0.113.1              │ veth  │  HTTP_PROXY=10.0.0.1  │
│   unknown.test 203.0.113.3              │◀─────▶│  holds NO credential  │
│   secure.test  203.0.113.2              │       │  10.0.0.2             │
│ credential proxy 10.0.0.1:3128          │       │                       │
│ udp :53 responder 10.0.0.1              │       │ nft OUTPUT: allow lo, │
│                                         │       │  udp/53, ->:3128; DROP│
└────────────────────────────────────────┘       └───────────────────────┘
```

The app is in a jail (APP netns) whose only sanctioned exits are the proxy and
DNS. The proxy lives outside the jail and is the single gate to the "internet"
(the upstream IPs). Enforcement is **topological**, not dependent on the app
cooperating.

## Files

| File | Role |
|------|------|
| `run.sh` | Builds the namespaces, wires everything, runs the six checks. |
| `upstream.ts` | The paid third-party API(s) over real TLS + a UDP `:53` stub. |
| `proxy.ts` | The credential proxy: raw-TCP forward proxy, `http://` attach + TLS origination, `CONNECT` tunnel, metadata audit log. |
| `client.ts` | The oblivious app — a stock HTTP client that just respects `HTTP_PROXY` and holds no credential. |
| `config.ts` | The declared upstreams / M2M credential set (stand-in for the fnox `env=false` set). |

## What each check proves (→ acceptance criteria on #12)

| Check | Criterion | Proven |
|-------|-----------|--------|
| 1 | app unaware it holds no cred; proxy attaches per-domain cred + **originates real TLS** on :443; upstream sees an authenticated request | `200`, `authed_as: …_PROXYHELD` (the proxy-held token the app never sent) |
| 2 | metadata log `{ts,app,dst_host,method,path,status,bytes}`; **never** the credential | log line has all fields; the token string appears **0 times** in the whole log |
| 3 | request already carrying `Authorization` passes through **untouched** (never-overwrite) | `authed_as: …_abc123XYZ` (the app's own user token), not the M2M token |
| 4 | non-declared host gets **no** credential (declared-upstreams-only) | `unknown.test` (routable, not in the M2M set) → `got_auth: null` |
| 5 | **fail-closed**: a direct connection bypassing the proxy has no egress; DNS excepted; guarantee doesn't rely on app cooperation | direct `https://weather.test/api` (no proxy) is dropped by nft; only `udp/53` escapes |
| 6 | `https://` is an opaque `CONNECT`, thin-logged, receives **no** cred — the documented limit | `secure.test` (**declared!**) over TLS → `saw_auth: null`; tunnel log has bytes only, no path/method/status |

Latest run: **6 passed, 0 failed** — see the issue #12 resolution comment for the
full transcript.

## Fidelity & limits

What is **faithfully** real here:
- **Real network isolation.** Two real Linux network namespaces joined by a real
  veth pair; the fail-closed drop is enforced by real netfilter rules in the app
  netns. The bypass in check 5 is dropped by the kernel, not by the app.
- **Real TLS origination.** The proxy does a genuine TLS handshake to the
  upstream on :443 and validates the server cert's SAN against a CA. Plaintext
  never leaves the host.
- **The proxy's attach/skip/never-overwrite logic** — the actual thing under
  test — is production-shaped.

Where this PoC **stands in** for production (fidelity gaps, all deliberate):
- **Rootless user namespace, not host root.** Uses `unshare --user
  --map-root-user` because the sandbox has no real root. Production Exhibit
  creates a **persistent** per-app netns owned by the `exhibitd` root daemon and
  joins it via systemd `NetworkNamespacePath=` (ADR 0002). The netns/veth/nft
  semantics are identical; what differs is ownership and lifetime (ephemeral
  here).
- **`iptables-nft`, not the legacy backend.** Legacy xtables needs the
  root-owned `/run/xtables.lock`; the nft backend works unprivileged in the
  userns. Same rules, same enforcement.
- **Config stand-in for fnox.** `config.ts` hard-codes the M2M credential set.
  In production it is the fnox `env=false` profile encrypted to the **proxy's**
  age recipient (ADR 0001 §3, revised by ADR 0002), so the app is
  cryptographically unable to read it. The proxy's *use* of the set is unchanged.
- **Throwaway PoC CA** (`NODE_EXTRA_CA_CERTS`) stands in for public CAs.
- **DNS** is an `/etc/hosts` overlay + a stub `:53` responder, standing in for
  the production `/etc/netns/<ns>/resolv.conf` path.
- **Raw-proxy simplifications:** forces `Connection: close`, ignores
  backpressure, no keep-alive/HTTP-2. Fine for tiny PoC payloads; not
  production-grade.

Known model limit (not a bug — the decided boundary):
- **`https://` gets no credential.** An app that calls `https://` opens an opaque
  `CONNECT` tunnel; the proxy sees only ciphertext and cannot inject auth (check
  6 proves even a *declared* host, `secure.test`, gets `saw_auth: null`). The
  operator rule stands: **`http://` = Exhibit attaches the credential and
  upgrades to TLS; `https://` = you own the auth.**

Not covered by this PoC (belongs to later tickets): persistent netns lifecycle,
the systemd unit wiring, Caddy ingress, multi-app concurrency, real fnox
decryption.
