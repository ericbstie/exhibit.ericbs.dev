---
status: accepted
---

# Releases, state, and logs: the filesystem is the source of truth

Resolves [#6](https://github.com/ericbstie/exhibit.ericbs.dev/issues/6), [#14](https://github.com/ericbstie/exhibit.ericbs.dev/issues/14), [#15](https://github.com/ericbstie/exhibit.ericbs.dev/issues/15), [#16](https://github.com/ericbstie/exhibit.ericbs.dev/issues/16).

**Releases.** The deploy payload is `git archive HEAD` (committed content only — `ex deploy` warns on a dirty tree), unpacked to `apps/<domain>/deployments/<timestamp>/` (same-second collisions get a `-<n>` suffix), built there by `prepare`, then cut over by a stop-then-start symlink swap of `current` with a VERIFY health check and auto-rollback. Releases are identified by **timestamp only** (no commit-SHA tracking for now — a possible later feature). Successful releases are never auto-pruned; the one exception is VERIFY-failed deploys, which are auto-cleaned. `ex rollback [<ts>]` is a symlink swap + restart of an already-built release (no re-`prepare` — you get back the exact bytes that ran); default target is the chronologically preceding release; it runs the same VERIFY but does not auto-roll-forward. `ex rm <ts>` deletes a release and reconciles, refusing `current` and its predecessor.

> **Deferred (ponytail):** `# ponytail: no ex rm / auto-prune reconcile in v1 (releases accumulate; delete dirs by hand), build the guarded ex rm when disk pressure actually needs it`

**State.** There is no central database. `apps/<domain>/.exhibit/` records only what cannot be derived from the filesystem, which collapses to a single file — `net.toml` holding the app's veth IP — allocated lowest-free by `exhibitd` scanning `apps/*/.exhibit/net.toml` (single writer by construction, no lock, no registry). Everything else — the release list, `current`, the rollback target — is derived from the directory layout. `ex ls` reports `{timestamp, current}` per release.

**Logs — two planes, split by need.** Operational logs ride journald: app stdout/stderr per `exhibit-app@` instance, proxy and Caddy as their own units; `ex logs <domain>` = `journalctl -u`, `--follow` = native tail, retention = journald's rolling caps. The outbound/inbound **traffic audit** is per-app append-only JSONL under the state dir (`apps/<domain>/audit/egress.jsonl` from the proxy, `ingress.jsonl` demuxed from Caddy's per-Host access logs — natively supported), read via `ex audit`, retained durably and pruned only deliberately. An audit record must not be vacuumed with operational churn, which is why it is *not* in journald; and journald stores one shared Caddy unit as opaque `MESSAGE` with no per-domain filter, which is why the audit is *not* journald-unified. JSONL rotation policy is deferred to build.
