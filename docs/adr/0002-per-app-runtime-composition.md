# Per-app runtime composition: systemd-declarative confinement in a persistent netns

Each deployed app runs as a single systemd service, instanced from **one**
`exhibit-app@.service` template (instance name = the app's domain), which
**declaratively** composes all confinement: it joins a **persistent per-app
Linux network namespace** via `NetworkNamespacePath=`, drops to an isolated
transient UID via `DynamicUser=`, and is write-confined by systemd's own
`ProtectSystem=strict` + `StateDirectory=`/`LogsDirectory=`. `ExecStart` therefore
collapses to `fnox exec -- mise run production`, and **mise is a task-runner only**.
systemd — which fails *closed* — is the enforcement floor.

```ini
# /etc/systemd/system/exhibit-app@.service   (ONE file, every app)
[Service]
DynamicUser=yes
NetworkNamespacePath=/run/netns/ns-%i
WorkingDirectory=/srv/apps/%i/current          # read-only release dir
ProtectSystem=strict
StateDirectory=exhibit/%i                        # /var/lib/private/exhibit/<domain>
LogsDirectory=exhibit/%i
# Environment=HTTP_PROXY=...  ← superseded by ADR 0008: transparent interception, no proxy env vars
ExecStart=fnox exec -- mise run production
Restart=on-failure
```

Adding an app is: provision the netns, then `systemctl enable --now
exhibit-app@<domain>`. No per-app unit file, no `useradd`.

## Status

accepted — amended 2026-07-17 after pre-implementation validation
([#18](https://github.com/ericbstie/exhibit.ericbs.dev/issues/18)); see
**Amendments** below. The secrets consequence ("enforced by fnox recipients")
was superseded by [#13](https://github.com/ericbstie/exhibit.ericbs.dev/issues/13)'s
final model → [ADR 0004](0004-secrets-model.md) (one exhibitd-held key,
decrypt-outside, injection-control). The `Environment=HTTP_PROXY` line in the
unit snippet is superseded by [ADR 0008](0008-transparent-interception-transport.md)
(no proxy env vars; transparent interception).

## Considered Options

**Why not mise `--deny-write` as the write-sandbox?** The whole map lists mise
`--deny-write` as an intended confinement mechanism, but the mise research
([#3](https://github.com/ericbstie/exhibit.ericbs.dev/issues/3)) found it is
experimental and **silently runs UNSANDBOXED on kernels < 5.13**, always leaves
`/tmp` writable, and does no network filtering — i.e. it fails *open*. systemd's
`ProtectSystem=strict` fails *closed*, is not kernel-gated, and confines the
process regardless. So mise keeps only its task model (`prepare` + long-running
`production`); it is deliberately **not** relied on for security. This reframes
the still-open mise-sandbox proof
([#10](https://github.com/ericbstie/exhibit.ericbs.dev/issues/10)) as
non-load-bearing for the spec.

**Why a persistent netns rather than one built per launch?** The namespace,
its veth pair, its **stable IP**, its fail-closed egress iptables, and its DNS
config are provisioned **once**, at app registration, and survive release swaps
and reboots. So Caddy's route target — the app's veth IP
([#9](https://github.com/ericbstie/exhibit.ericbs.dev/issues/9)) — never moves,
and the release cutover
([#6](https://github.com/ericbstie/exhibit.ericbs.dev/issues/6)) is a pure
symlink swap that never touches the network path. The systemd unit merely
*enters* the existing namespace.

**Why a template + `DynamicUser` rather than generated per-app units + static
users?** One template is a single file to audit and evolve; `DynamicUser`
grants each app an isolated transient UID with zero user pre-creation, and its
`StateDirectory`/`LogsDirectory` are auto-created and auto-owned. The cost — the
release dir must be read-only and all app-writable state must live under the
managed dirs — is a constraint the symlink-swap release model imposes anyway
(state written inside a release dir is orphaned on the next deploy).

## Consequences

- **Privilege is separated.** A single long-lived root daemon, **`exhibitd`**,
  holds all privilege (writes units, `systemctl`, `ip netns`, veth/iptables,
  Caddy reload). The SSH forced-command (
  [#7](https://github.com/ericbstie/exhibit.ericbs.dev/issues/7)) runs an
  **unprivileged** `exhibit-server` front-end that relays the archive + NDJSON
  stream to `exhibitd` over a local Unix socket. This refines #7's "escalates to
  root as needed": the SSH entry point never escalates — it hands a message to
  the one reviewed root process.

- **Egress is fail-closed at the namespace.** The persistent netns withholds
  host masquerade; its default route is veth → host → the credential proxy only
  ([#4](https://github.com/ericbstie/exhibit.ericbs.dev/issues/4),
  [#8](https://github.com/ericbstie/exhibit.ericbs.dev/issues/8)). `HTTP_PROXY`
  is a non-secret and is injected via the unit's `Environment=`.

- **Secrets ride in-boundary; the app/proxy split is enforced by fnox
  recipients, not by re-channelling.** The deploy payload — the app's
  `fnox.toml`, an optional committed `.env`, code, and a new **`.exhibit`**
  config file — enters the app's boundary **unmodified**; Exhibit dissects
  nothing. The app decrypts and reads its **own** secrets (including in-boundary
  crypto material — DB/field-encryption keys, signing keys) itself. The
  **proxy's M2M credentials** live in a dedicated **fnox profile** (default
  `production`, selected by `.exhibit`) whose secrets are encrypted to the
  **proxy's own age recipient**: the operator runs **`ex age-key show`**, adds
  that public key to the profile's `recipients`, re-encrypts, and pushes. Those
  ciphertexts sit in the same `fnox.toml` inside the boundary but are
  **decryptable only by the proxy** — a *cryptographic* enforcement of #8's "the
  app never holds M2M creds," replacing the leaky `env=false` convention.
  `.exhibit` is visible in the boundary but inert to the app: only the proxy
  reads it, to learn how to proxy. Remaining mechanics — per-app app-key
  provisioning, the proxy's age keypair behind `ex age-key show`, the `.exhibit`
  schema (and reconciling it with #6's `.exhibit/commit` sidecar), and the exact
  profile/`--no-defaults` shape — are deferred to
  [#13](https://github.com/ericbstie/exhibit.ericbs.dev/issues/13), which
  **revises #5** (grouping *is* possible via profiles + recipients) **and #8**
  (the M2M guarantee is now cryptographic).

- **Deployed-app contract.** An app must keep all writable state under its
  systemd-managed `StateDirectory`/`LogsDirectory`, never in its release dir.

## Amendments (2026-07-17 — pre-implementation validation #18)

Command-verified findings that the unit template and exhibitd must honor:

- **DNS delivery.** `/etc/netns/<ns>/resolv.conf` is an `ip netns exec` convention;
  `NetworkNamespacePath=` does **not** apply it (systemd
  [#28694](https://github.com/systemd/systemd/issues/28694) — reproduced). The template
  adds `BindReadOnlyPaths=/etc/netns/ns-%i/resolv.conf:/etc/resolv.conf:norbind`
  (valid because `NetworkNamespacePath=` implies `PrivateMounts=` since v254; bind a
  regular file, not a resolved symlink — systemd
  [#32366](https://github.com/systemd/systemd/issues/32366)).
- **Reboot reconcile.** `/run/netns`, veths, and nftables rules are tmpfs-resident and
  vanish at reboot — "provisioned once" requires `exhibitd` to re-create every app's
  network at boot (oneshot unit, `RemainAfterExit=yes`), with `exhibit-app@` instances
  ordered `After=`/`BindsTo=` it. Fail-closed means un-reconciled apps refuse to start
  rather than run unsandboxed — intended.
- **`prepare` runs inside the same confinement** as `production` (transient unit in the
  app's netns, write access only to the not-yet-current release dir). Registry fetches
  work through ADR 0008's transparent `:443` passthrough; no sandbox exception.
- **journald rate limit.** journald drops >10k lines/30s per unit by default; the
  template sets `LogRateLimitBurst=` explicitly so app logs aren't silently dropped.
- **Capability hardening.** The ADR 0008 interception rules live inside the app's netns:
  the unit drops `CAP_NET_ADMIN` (`CapabilityBoundingSet=`) and sets
  `RestrictNamespaces=yes` so the app cannot rewrite its own egress policy.
- **Ownership floor.** `DynamicUser=` + `StateDirectory=` uses idmapped mounts on
  systemd ≥257 (Debian 13); older systemd falls back to recursive chown — correct,
  slower on large state.
