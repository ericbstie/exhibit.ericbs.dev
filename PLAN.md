# Plan

Goal: `ex deploy --domain x -- <cmd>` on a bare VPS → sandboxed app live with TLS, in seconds. No Docker.

## Components

| Component | Decision |
|---|---|
| Ingress | pinned xcaddy-built Caddy, separate process, driven via admin API (`POST /load`, `@id` routes) |
| TLS | wildcard cert via DNS-01 for the base domain + on-demand TLS (`ask` endpoint served by `ex`) for custom domains |
| DNS | libdns provider packages, consumed directly by `ex` |
| Sandbox | per-app linux user + generated systemd unit (`ProtectSystem=strict`, `IPAddressDeny=any`, `MemoryMax`, `CPUQuota`); + Landlock where the kernel has it; bwrap `--unshare-all` fallback without systemd |
| Egress | own Go proxy (goproxy-based): deny-by-default allowlist, SSRF guard (smokescreen-style), placeholder→secret injection, JSONL audit log, one unix socket per app |
| Daemon | `ex` (Go): CLI + HTTP API + dashboard; owns the app DB; renders Caddy config and systemd units from it |

All verified feasible hands-on except systemd hardening and real ACME - see RESEARCH.md §4.

## Milestones

**M1 - ingress core.** `ex` daemon manages Caddy; `ex deploy` registers an app, runs its command, wires a unix-socket route.
Accept: two apps live side by side; redeploy swaps the upstream with zero downtime.

**M2 - sandbox.** Per-app user + hardened unit; capability detection (systemd version, Landlock ABI) with per-app status.
Accept: on stock Ubuntu 24.04, an app cannot read another app's files nor reach the internet directly.

**M3 - egress.** Proxy with allowlist + audit log; `HTTP(S)_PROXY` env wiring; placeholder secret injection for plain HTTP and CONNECT.
Accept: the RESEARCH.md §4.3 scenario end-to-end - allowed host gets injected Bearer, denied host gets 403, both audited.

**M4 - domains.** libdns record creation, wildcard DNS-01, on-demand TLS ask endpoint.
Accept: a fresh subdomain serves valid HTTPS seconds after deploy.

**M5 - dashboard.** Logs, health, audit viewer, sandbox status per app. Opt-in MITM CA mode for HTTPS body injection (with exclude list for cert-pinning clients).

## Non-goals (v1)

Multi-server, builds/buildpacks (bring your own run command), Windows, per-host network rules inside mise's sandbox (composes anyway - its `--deny-net` allows unix sockets).

## Open questions

- HTTPS secret injection default: placeholder-over-CONNECT only, or MITM CA on by default?
- Default resource limits per app (`MemoryMax`, `CPUQuota`)?
- Log retention/rotation for app logs and the audit log.
