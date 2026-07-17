---
status: accepted
---

# Secrets: one exhibitd-held age key, decrypt outside the boundary, two fnox profiles

Resolves [#13](https://github.com/ericbstie/exhibit.ericbs.dev/issues/13); this is the final model, superseding the per-recipient scheme sketched in [ADR 0002](0002-per-app-runtime-composition.md)'s secrets consequence.

Secrets live age-encrypted in the app's committed `fnox.toml` (rides into each release via git archive). A **single age key** is held by `exhibitd`, outside every app boundary; it never crosses in. `exhibitd` decrypts **outside** and hands each consumer only what it is due:

- the **`production`** profile (app secrets) is injected as plaintext env into the confined app;
- the **`exhibit`** profile (per-host M2M credentials) goes to the credential proxy and is **never** injected.

The guarantee is **injection-control + key-absence**, not per-recipient crypto: the app can read its own `fnox.toml` but holds no key to decrypt anything, and `exhibitd` injects only the declared injectable profile. A deployment may override which profile is injectable via its committed `.exhibit/config.toml` (default `production`) — distinct from the app-root `.exhibit/` state directory, which is exhibitd-managed only (ADR 0005).

Key rotation uses age's native multi-identity / multi-recipient support (verified end-to-end, [#18](https://github.com/ericbstie/exhibit.ericbs.dev/issues/18)): `ex key rotate` appends a new identity to the host key file (old **or** new decrypts), the operator re-encrypts each app's `fnox.toml` (`fnox reencrypt`) and redeploys at their own pace, and `ex key retire-old` drops the old identity once all apps have migrated — zero-downtime, non-atomic, per-app. A flag-day atomic swap was rejected (impossible under independent per-app deploys). `fnox reencrypt` prompts interactively, so `ex key` commands must drive it non-interactively. The injection channel (systemd tmpfs credentials vs root-owned `EnvironmentFile=`) is deferred to build. The single key's own generation/storage/rotation lifecycle lives in bootstrap (ADR 0007).
