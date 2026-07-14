# PoC: systemd write-confinement (ProtectSystem=strict + DynamicUser)

**Throwaway prototype** proving Exhibit issue
[#10](https://github.com/ericbstie/exhibit.ericbs.dev/issues/10) — the second of
the core engine's two headline de-risking proofs (the first: the
[netns credential proxy](https://github.com/ericbstie/exhibit.ericbs.dev/issues/12)).
It demonstrates the runtime composition ADR 0002 decided: one
`exhibit-app@<domain>.service` template whose `ExecStart` is
`fnox exec -- mise run production`, write-confined **by systemd itself** —
`ProtectSystem=strict` + `DynamicUser=` + `StateDirectory`/`LogsDirectory` —
and joined to the persistent per-app netns via `NetworkNamespacePath=`.

This confinement **replaces** mise `--deny-write` as the sandbox floor: mise's
sandbox fails *open* on kernels < 5.13 (silently unsandboxed, see
[#3](https://github.com/ericbstie/exhibit.ericbs.dev/issues/3)); systemd fails
*closed* — a confinement it cannot set up means the unit **does not start**.
Criterion 4 demonstrates exactly that.

## Run it

```bash
sudo ./run.sh   # needs root + systemd as PID 1; fnox, mise, bun, age-keygen, ip
```

Prints `PASS`/`FAIL` per check (27 checks across the 5 acceptance criteria)
and exits non-zero on any failure. It writes to real system paths
(`/run/systemd/system`, `/srv/exhibit`, `/etc/exhibit`, netns `exhibit-*`) and
removes all of it on exit — still, run it on a disposable box. `KEEP=1
./run.sh` leaves everything standing for inspection.

Latest run: **27 passed, 0 failed** on systemd 257 / Debian 13 — full
transcript in the issue #10 resolution comment.

## What it stands up

```
/run/systemd/system/exhibit-app@.service        the template under test
/srv/exhibit/apps/<domain>/deployments/<ts>/    release dir (per #6 layout)
/srv/exhibit/apps/<domain>/current -> <ts>/     atomic cutover symlink
/etc/exhibit/age/<domain>.key                   per-app age key (LoadCredential=)
/run/netns/exhibit-<domain>                     persistent per-app netns
```

Two instances — `exhibit-app@alpha.test` and `exhibit-app@beta.test` — each
running a probe app (`app/server.ts` via `fnox exec -- mise run production`)
that reports its identity and attempts a matrix of writes; `run.sh` judges the
journal output against the criteria. The app asserts nothing itself:
confinement must hold without app cooperation.

## What each check group proves (→ acceptance criteria on #10)

| Criterion | Proven |
|-----------|--------|
| 1. Own dirs writable | `$STATE_DIRECTORY` and `$LOGS_DIRECTORY` writable; **release dir EROFS at runtime** (the decision — see below); the `prepare` artifact written pre-cutover is readable |
| 2. Everything else denied | `/etc`, `/usr`, `/` → EROFS; sibling instance's state/logs → **ENOENT** (not even visible); host confirms no intrusion files exist |
| 3. Unprivileged identity | uid in the dynamic range (61184–65519), non-root, **no `/etc/passwd` entry**; state persists and stays owned by the app across a restart |
| 4. Fails closed | missing netns → `systemctl start` **refuses** (unit `failed`, no unconfined run); unsatisfiable `ReadWritePaths=` → same. Never a silent fallback |
| 5. Composes with netns | app's `/proc/self/ns/net` inode == `/run/netns/exhibit-<domain>`, ≠ host, ≠ sibling; criteria 1–2 and in-boundary fnox decryption all hold *inside* the netns |

## Decisions recorded (criterion 1's open question)

**The release dir is immutable-read-only at runtime.** No `ReadWritePaths=`
carve-out for the app's own tree: `prepare` runs against the new release
*before* the symlink swap, in deploy context (root, unconfined), so build
outputs land in the release dir then; at runtime every write belongs in
`StateDirectory` (data) or `LogsDirectory` (logs). A runtime write to the
release tree returns EROFS. This keeps releases bit-identical to what was
deployed and makes rollback (#14) trivially safe.

## Findings & surprises

- **ID-mapped mounts make ownership a non-issue.** On the host, state files
  show owner `65534` (nobody); inside the sandbox the same files are owned by
  the dynamic UID. systemd (≥256) ID-maps the `StateDirectory` mount rather
  than chowning, so a UID change across restarts costs nothing and ownership
  "stays correct" by construction. (`/var/lib/exhibit/<domain>` is itself a
  symlink into `/var/lib/private/exhibit/<domain>` — the DynamicUser layout.)
- **The UID was stable across restarts in practice** (allocation hashes the
  unit name), but nothing depends on that — see previous point.
- **Sibling state isn't just unwritable, it's invisible.** Probes against the
  other instance's dirs fail ENOENT: only the unit's own `StateDirectory` is
  mounted into its namespace. Stronger isolation than the EACCES we expected.
- **In-sandbox username is `exhibit-app`** (the template prefix), resolved by
  nss-systemd at runtime only; nothing is ever written to `/etc/passwd`.
- **`LoadCredential=` is the right key-delivery for fnox under DynamicUser**:
  `LoadCredential=age.key:/etc/exhibit/age/%i.key` +
  `Environment=FNOX_AGE_KEY_FILE=%d/age.key` hands the app its decryption key
  readable only by the unit — no world-readable key file, no chown dance.
  Feeds the secrets mechanics ticket
  [#13](https://github.com/ericbstie/exhibit.ericbs.dev/issues/13).
- **Tooling needs scratch dirs under strict confinement.** mise/bun/fnox want
  `HOME` and cache/state dirs; pointing them into `PrivateTmp`'s `/tmp`
  (`MISE_DATA_DIR` etc.) plus `MISE_TRUSTED_CONFIG_PATHS=/srv/exhibit` and
  `fnox --no-daemon` makes the stack run clean with zero writable carve-outs.
  These `Environment=` lines belong in the production template.

## Fidelity & limits

Faithfully real: systemd 257 as PID 1, real root, real `DynamicUser` +
`ProtectSystem=strict` mount namespacing, real persistent netns joined by
`NetworkNamespacePath=`, real age-encrypted `fnox.toml` decrypted in-boundary,
real `mise run` task execution, two concurrent instances.

Stand-ins (deliberate):

- **The app is a probe script**, not a real webapp; it exercises the boundary,
  it doesn't serve traffic. Ingress/egress wiring inside the netns (veth,
  proxy, fail-closed nft rules) is the netns PoC's territory (#12) — here the
  netns is empty (lo only), which is enough to prove the *join* composes.
- **The netns is created by `run.sh`**, standing in for `exhibitd`-owned
  provisioning (production wires `Requires=`/`After=` on an
  `exhibit-netns@.service` or equivalent).
- **`.exhibit` config file** is not modeled (no proxy in this PoC); the fnox
  profile is hard-set to `production`.
- Unit installed in `/run/systemd/system` (gone on reboot) — production
  installs under `/etc/systemd/system`.

Not covered (later tickets): the deploy pipeline itself (#6 is decided, not
built), secrets mechanics beyond key delivery (#13), retention/rollback
(#14), server state (#15).
