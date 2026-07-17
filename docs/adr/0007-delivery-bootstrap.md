---
status: accepted
---

# Delivery and bootstrap: mise as the install channel, `ex init-server` as the provisioner

Resolves [#17](https://github.com/ericbstie/exhibit.ericbs.dev/issues/17).

Exhibit is delivered to the VPS via mise (`mise use github:ericbstie/exhibit && mise exec -- ex init-server`) — mise is already a server prerequisite (apps run `mise run production`), so it doubles as the install channel. **This requires publishing GitHub Releases with pre-built per-arch binaries** (e.g. `bun build --compile`): mise's github backend installs release assets, not a bare repo (pre-implementation validation [#18](https://github.com/ericbstie/exhibit.ericbs.dev/issues/18)), so release engineering is part of shipping v1.

`ex init-server` is the idempotent on-box provisioner (distinct from the laptop's remote `ex`, ADR 0006): it stands up `exhibitd`, the `exhibit-app@.service` template, the boot-time network reconcile unit (ADR 0002), Caddy, and the exhibit root layout; it generates the single age key once (`age-keygen`, root-owned `0600` at `FNOX_AGE_KEY_FILE`, outside every app boundary per ADR 0004) and prompts **`ex key export`** as a first-class backup step. Rotation is the dual-key transition window described in ADR 0004; the exact `ex key` command surfaces and prereq ordering are deferred to build.
