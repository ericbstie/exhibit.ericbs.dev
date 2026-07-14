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
Environment=HTTP_PROXY=http://<host-veth-ip>:<proxy-port>   # non-secret (#8)
ExecStart=fnox exec -- mise run production
Restart=on-failure
```

Adding an app is: provision the netns, then `systemctl enable --now
exhibit-app@<domain>`. No per-app unit file, no `useradd`.

## Status

accepted

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

- **Secrets cross the privilege boundary from the root side.** Because the app
  runs as an unprivileged `DynamicUser` with no access to the age key, app-env
  secrets are decrypted on the **privileged side** (`exhibitd`) and delivered to
  the process through a systemd-mediated channel; M2M credentials **never enter
  the app** (they terminate at the proxy). The exact channel and the per-class
  decrypt location are deferred to
  [#13](https://github.com/ericbstie/exhibit.ericbs.dev/issues/13), which now
  fits inside this composition.

- **Deployed-app contract.** An app must keep all writable state under its
  systemd-managed `StateDirectory`/`LogsDirectory`, never in its release dir.
