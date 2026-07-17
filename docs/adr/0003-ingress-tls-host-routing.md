---
status: accepted
---

# Ingress: Caddy on the host, explicit per-domain certs, veth-IP routing

Resolves [#9](https://github.com/ericbstie/exhibit.ericbs.dev/issues/9).

Caddy runs in the root netns as the single TLS terminator and Host-header router. Every app listens on the same fixed internal port inside its own netns (collision-free by isolation), so Caddy routes `Host → <app-veth-IP>:<port>` over the veth as a plaintext local hop. The veth IP is a field of existing per-app state (ADR 0005), not a registry.

Certificates are **per-domain via HTTP-01, issued eagerly at deploy**: `exhibitd` adds each declared domain to Caddy through the admin API (`localhost:2019`, atomic zero-downtime config apply) at registration. No wildcard certs, therefore no DNS-provider API — DNS management stays out of scope; deploy takes `--domain` as given (an A record pointing at the VPS is a deploy prerequisite; a bad one surfaces in deploy output, not as a first-visitor TLS stall).

## Considered options

- **On-demand TLS + `ask` endpoint (the original #9 decision, superseded by pre-implementation validation [#18](https://github.com/ericbstie/exhibit.ericbs.dev/issues/18)).** On-demand issuance is designed for domains the operator does *not* control; Exhibit's operator declares every domain at deploy time, so explicit config is strictly simpler — the `ask` endpoint disappears and issuance failures surface at deploy instead of on first visit. Let's Encrypt rate limits are a non-issue at this scale either way (50 certs/registered-domain/week, ZeroSSL fallback). On-demand can return if arbitrary customer-owned domains are ever accepted.
- **Fronting Caddy with the credential proxy** for unified traffic capture: rejected — it breaks on TLS (terminate = rebuild ACME; passthrough = L4-only) and puts the secrets-bearing component on the public edge. Ingress (Caddy) and egress (the credential proxy, ADR 0001/0008) stay separate components sharing the veth in opposite directions; the unified audit is a log-layer concern — Caddy per-Host L7 access logs + proxy egress logs into one per-app store (ADR 0005).
