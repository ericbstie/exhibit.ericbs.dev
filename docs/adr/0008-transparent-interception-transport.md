---
status: accepted
---

# Transport revision: transparent interception replaces proxy env vars

Supersedes the transport clause (Decision §1) of [ADR 0001](0001-transparent-credential-proxy-model.md). Everything else in ADR 0001 stands: `http://`-only credential attachment with TLS origination, declared-upstreams + never-overwrite, metadata-only logging, and the fail-closed netns floor.

## What changed

Apps no longer receive `HTTP_PROXY`/`HTTPS_PROXY`. Instead, nftables inside the app netns intercepts egress transparently (`nat OUTPUT` — the packets are locally generated, so `PREROUTING` never sees them):

- **tcp/80** → DNAT to the proxy's HTTP listener on the gateway side of the veth. The proxy recovers the intended upstream **per request** from the `Host` header, attaches the credential if the host is declared, and originates real TLS to the upstream on :443.
- **tcp/443** → DNAT to the proxy's passthrough listener. The proxy recovers the upstream from the TLS ClientHello SNI, tunnels opaque bytes to the real upstream:443 (thin-logged, never credentialed).
- **udp/53** → allowed to the gateway resolver only (an open :53 would be a DNS-tunnel exfil channel). Everything else, including udp/443 (HTTP/3), is dropped; h3-capable clients fall back to TCP.

The proxy always dials its **own** DNS resolution of the recovered host — never the packet's original destination IP. (`SO_ORIGINAL_DST` is unavailable anyway: the accepted socket lives in the gateway netns, whose conntrack has no app-netns entry — so Host/SNI recovery is the only option, not an optimization.)

## Why

Pre-implementation validation ([#18](https://github.com/ericbstie/exhibit.ericbs.dev/issues/18)) command-tested the env-var transport and found it broken for real runtimes: stock Node `fetch` ignores proxy env entirely (= zero egress in a fail-closed netns), Node with `NODE_USE_ENV_PROXY=1` sends CONNECT even for `http://` targets (credential injection impossible without unwrapping), Node's `http` module (under axios/got) ignores env, and curl honors only the lowercase variant. Only Bun behaved. The env-var transport made the platform's flagship feature depend on a per-runtime support matrix.

Transparent interception needs **zero app cooperation** and works identically for every runtime and package manager — including registry fetches during `prepare`, and `https://` SDK traffic, which now passes through instead of dying in the fail-closed netns. Istio's egress TLS origination ships this exact plaintext-in/TLS-out-via-transparent-redirect pattern. The operator rule is unchanged: **`http://` = Exhibit attaches the credential and upgrades to TLS; `https://` = you own the auth.**

## Consequences (hardening requirements from adversarial review, #18)

- **The proxy is a small security-critical component and must be built as one.** Routing is per **request**, never per connection (keep-alive can switch `Host` mid-connection — per-connection routing is a credential-misdirection bug). Duplicate/conflicting `Host` headers are rejected (request smuggling); absolute-form request lines are accepted (RFC 7230); chunked bodies are streamed; `101 Upgrade` (websockets) switches to raw tunneling.
- **No-Host / no-SNI fails closed.** HTTP/1.0 without `Host`, h2c prior-knowledge cleartext, and raw-IP HTTPS (no SNI) are rejected and logged — rare for server-side egress, acceptable.
- **Non-80/443 TCP is unreachable by default** (external Postgres, Redis, SMTP, `:8443` APIs). A deployment declares `host:port` passthrough entries in its `.exhibit/config.toml`; `exhibitd` resolves and installs direct, flow-logged accept rules at provisioning. (SNI-peek can't help Postgres/STARTTLS, which sends a plaintext preamble before the ClientHello — hence an explicit allowlist.) **Deferred (ponytail):** `# ponytail: no non-80/443 passthrough allowlist in v1 (local-socket apps need none), add host:port entries when an app first dials external Postgres/Redis/SMTP`
- **Capability hardening.** The interception rules live inside the app's netns, so the unit drops `CAP_NET_ADMIN` and sets `RestrictNamespaces=yes` (ADR 0002) — an unprivileged userns grants CAP_NET_ADMIN only over new, veth-less, egress-less netns, so fail-closed holds.
- **ECH watch.** :443 host recovery relies on plaintext ClientHello SNI. Installed server-side toolchains don't send Encrypted Client Hello today (OpenSSL 4.x ships it experimental; RFC 9849 finalized 2026-03), but when runtimes enable it by default, SNI recovery degrades — revisit then via declared passthrough or the per-app MITM opt-in seam that ADR 0001 left open.
- **The build budget is honest:** transparent interception means writing a small, security-critical HTTP/TLS router (per-request routing, smuggling defenses, Upgrade handling). This is real work — but strictly less fragile than an empirically-broken env-var matrix or a per-runtime MITM trust-store injection.
