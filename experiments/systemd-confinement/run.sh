#!/usr/bin/env bash
# PROTOTYPE — one-command proof for exhibit issue #10:
# systemd write-confinement (ProtectSystem=strict + DynamicUser) as the
# load-bearing sandbox floor, composed with a persistent per-app netns.
#
# Needs: root, a running systemd (PID 1), fnox, mise, bun, age-keygen, ip.
# Touches real system paths (/run/systemd/system, /srv/exhibit, /etc/exhibit,
# /var/lib/private/exhibit, netns exhibit-*) — run on a disposable box.
# Cleans up after itself; KEEP=1 ./run.sh to leave everything standing.

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
DOMAINS=(alpha.test beta.test)
PASS=0 FAIL=0

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
note() { printf '  \033[2m....\033[0m %s\n' "$*"; }
assert(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
assert_not(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi; }
denied(){ [ -n "$1" ] && [ "$1" != OK ]; }

unit()  { echo "exhibit-app@$1.service"; }
iid()   { systemctl show -p InvocationID --value "$(unit "$1")"; }
jlog()  { journalctl -q _SYSTEMD_INVOCATION_ID="$1" -o cat 2>/dev/null; }
# last `PROBE <label> ... result=X` / `IDENT key=v` of an invocation
presult(){ jlog "$1" | sed -n "s/^PROBE $2 .*result=//p" | tail -1; }
ident()  { jlog "$1" | sed -n "s/^IDENT $2=\([^ ]*\).*/\1/p" | tail -1; }
wait_probes(){ # wait_probes <invocation-id>
  for _ in $(seq 1 120); do
    jlog "$1" | grep -q '^PROBES-DONE' && return 0
    sleep 0.5
  done
  return 1
}
nsino(){ stat -Lc %i "$1" 2>/dev/null; }

cleanup(){
  systemctl stop 'exhibit-app@*' >/dev/null 2>&1
  systemctl reset-failed 'exhibit-app@*' >/dev/null 2>&1
  rm -f /run/systemd/system/exhibit-app@.service
  rm -rf /run/systemd/system/exhibit-app@*.service.d
  systemctl daemon-reload
  for d in "${DOMAINS[@]}"; do ip netns delete "exhibit-$d" 2>/dev/null; done
  rm -rf /srv/exhibit /etc/exhibit
  rm -rf /var/lib/private/exhibit /var/log/private/exhibit
  # /var/lib/exhibit and /var/log/exhibit are symlinks systemd creates for
  # DynamicUser StateDirectory/LogsDirectory; remove whichever form exists
  rm -rf /var/lib/exhibit /var/log/exhibit
}

say "preflight"
[ "$(id -u)" = 0 ] || { echo "must run as root"; exit 1; }
[ -d /run/systemd/system ] || { echo "systemd is not PID 1 here"; exit 1; }
for bin in fnox mise bun age-keygen ip; do
  command -v "$bin" >/dev/null || { echo "missing: $bin"; exit 1; }
done
note "systemd $(systemctl --version | head -1 | cut -d' ' -f2), $(fnox --version), mise $(mise version 2>/dev/null | cut -d' ' -f1), bun $(bun --version)"
cleanup   # idempotent: clear any previous run
[ "${KEEP:-}" = 1 ] || trap cleanup EXIT

say "stage: unit template, releases, secrets, netns"
install -m644 "$HERE/exhibit-app@.service" /run/systemd/system/
systemctl daemon-reload
export MISE_TRUSTED_CONFIG_PATHS=/srv/exhibit
for d in "${DOMAINS[@]}"; do
  # release layout per the deploy-lifecycle decision (#6):
  # apps/<domain>/deployments/<ts>/ + atomic `current` symlink
  rel="/srv/exhibit/apps/$d/deployments/$(date -u +%Y%m%d%H%M%S)"
  mkdir -p "$rel"
  cp "$HERE/app/mise.toml" "$HERE/app/server.ts" "$rel/"

  # per-app age key (deploy-time secret provisioning, ADR 0002 model:
  # the app decrypts its own secrets; key delivered via LoadCredential=)
  mkdir -p /etc/exhibit/age
  age-keygen -o "/etc/exhibit/age/$d.key" 2>/dev/null
  chmod 600 "/etc/exhibit/age/$d.key"
  cat > "$rel/fnox.toml" <<EOF
[providers.age]
type = "age"
recipients = ["$(age-keygen -y "/etc/exhibit/age/$d.key")"]

[profiles.production.secrets]
EOF
  FNOX_AGE_KEY_FILE="/etc/exhibit/age/$d.key" \
    fnox set --no-daemon -c "$rel/fnox.toml" -P production \
    APP_GREETING "hello-from-fnox-$d" --provider age >/dev/null

  # `prepare` runs against the new release BEFORE cutover, in deploy context
  # (root, no confinement) — the release dir is writable exactly here
  (cd "$rel" && mise run prepare >/dev/null 2>&1) \
    && note "$d: prepare wrote into the release dir pre-cutover" \
    || bad "$d: mise run prepare failed"

  ln -sfn "$rel" "/srv/exhibit/apps/$d/current"

  # persistent per-app netns (production: owned by exhibitd, provisioned once)
  ip netns add "exhibit-$d"
  ip -n "exhibit-$d" link set lo up
done

say "launch: systemctl start both instances"
for d in "${DOMAINS[@]}"; do
  systemctl start "$(unit "$d")" || bad "$d: unit failed to start"
done
declare -A IID1
for d in "${DOMAINS[@]}"; do
  IID1[$d]=$(iid "$d")
  wait_probes "${IID1[$d]}" || bad "$d: probes never completed (see journalctl -u $(unit "$d"))"
done
a=${IID1[alpha.test]} b=${IID1[beta.test]}
note "alpha.test: uid=$(ident "$a" uid) secret=$(ident "$a" secret) prepared=$(ident "$a" prepared)"

say "criterion 1 — own dirs writable; release dir immutable at runtime"
assert "state dir writable (\$STATE_DIRECTORY)"        [ "$(presult "$a" state)" = OK ]
assert "logs dir writable (\$LOGS_DIRECTORY)"          [ "$(presult "$a" logs)" = OK ]
assert "state file visible on host"                    test -s /var/lib/exhibit/alpha.test/probe.txt
assert "release dir NOT writable at runtime (EROFS)"   [ "$(presult "$a" release)" = EROFS ]
assert "prepare artifact readable at runtime"          [ "$(ident "$a" prepared)" != "(missing)" ]
note "decision recorded: release dir is immutable-read-only at runtime;"
note "writes happen at prepare-time (pre-cutover) or in StateDirectory"

say "criterion 2 — everything else denied, without app cooperation"
for probe in etc usr rootfs; do
  r=$(presult "$a" "$probe")
  assert "write to /$probe denied ($r)"                denied "$r"
done
rs=$(presult "$a" sibling-state) rl=$(presult "$a" sibling-logs)
assert "write to sibling state dir denied ($rs)"       denied "$rs"
assert "write to sibling logs dir denied ($rl)"        denied "$rl"
note "sibling dirs fail ENOENT: other instances' state isn't even visible"
assert "no intrusion file in beta's state (host view)" test ! -e /var/lib/exhibit/beta.test/intrusion.txt
assert "no intrusion file in /etc (host view)"         test ! -e /etc/exhibit-intrusion.txt

say "criterion 3 — DynamicUser: ephemeral non-root UID, no useradd"
uid1=$(ident "$a" uid)
assert "runs non-root (uid=$uid1)"                     [ -n "$uid1" -a "$uid1" != 0 ]
assert "uid in dynamic range 61184-65519"              [ "$uid1" -ge 61184 -a "$uid1" -le 65519 ]
assert_not "no persistent /etc/passwd entry"           grep -q ":$uid1:" /etc/passwd
note "in-sandbox username: $(ident "$a" username) (nss-systemd, runtime-only)"

note "restarting alpha.test to observe UID + state ownership across runs"
systemctl restart "$(unit alpha.test)"
a2=$(iid alpha.test)
wait_probes "$a2" || bad "alpha.test: probes never completed after restart"
uid2=$(ident "$a2" uid)
[ "$uid1" = "$uid2" ] \
  && note "uid stable across restart ($uid1) — allocation hashes the unit name" \
  || note "uid CHANGED across restart ($uid1 -> $uid2) — systemd re-chowns StateDirectory"
assert "previous run's state readable after restart"   [ "$(ident "$a2" previous_run)" != "(none)" ]
assert "state still writable after restart"            [ "$(presult "$a2" state-persist)" = OK ]
inowner=$(ident "$a2" state_owner)
assert "state owned by the app inside the sandbox (owner=$inowner, uid=$uid2)" [ "$inowner" = "$uid2" ]
hostowner=$(stat -c %u /var/lib/exhibit/alpha.test/restarts.log)
note "host view: owner=$hostowner (nobody) — systemd ID-maps the mount, so"
note "in-sandbox ownership tracks the dynamic UID with no chown needed"

say "criterion 4 — fails closed: broken confinement refuses to start"
systemctl stop "$(unit alpha.test)"
ip netns delete exhibit-alpha.test
if systemctl start "$(unit alpha.test)" 2>/dev/null; then
  bad "unit STARTED despite missing netns — silent unsandboxed run!"
else
  ok "missing netns -> systemctl start fails (no unconfined fallback)"
fi
assert "unit is in failed state, not running"          [ "$(systemctl is-active "$(unit alpha.test)")" != active ]
note "journal: $(journalctl -u "$(unit alpha.test)" -o cat -n 20 | grep -m1 -iE 'namespace|failed at step' || echo '(see journalctl)')"
systemctl reset-failed "$(unit alpha.test)" >/dev/null 2>&1

# same fail-closed class, filesystem side: a confinement path that can't be set up
mkdir -p /run/systemd/system/exhibit-app@beta.test.service.d
printf '[Service]\nReadWritePaths=/does-not-exist-exhibit\n' \
  > /run/systemd/system/exhibit-app@beta.test.service.d/broken.conf
systemctl daemon-reload
if systemctl restart "$(unit beta.test)" 2>/dev/null; then
  bad "unit STARTED despite unsatisfiable ReadWritePaths"
else
  ok "unsatisfiable ReadWritePaths -> start refused (fs-side fail-closed)"
fi
rm -rf /run/systemd/system/exhibit-app@beta.test.service.d
systemctl daemon-reload
systemctl reset-failed "$(unit beta.test)" >/dev/null 2>&1

note "contrast: mise --deny-write on kernel <5.13 runs UNSANDBOXED silently (#3)"

note "restoring alpha's netns and restarting both"
ip netns add exhibit-alpha.test
ip -n exhibit-alpha.test link set lo up
for d in "${DOMAINS[@]}"; do
  systemctl restart "$(unit "$d")" || bad "$d: failed to restart after restore"
done
a3=$(iid alpha.test); b3=$(iid beta.test)
wait_probes "$a3" && wait_probes "$b3" || bad "probes never completed after restore"

say "criterion 5 — composes with the persistent per-app netns"
alpha_ns=$(ident "$a3" netns | tr -dc 0-9)
beta_ns=$(ident "$b3" netns | tr -dc 0-9)
host_ns=$(nsino /proc/1/ns/net)
assert "alpha app netns == /run/netns/exhibit-alpha.test"  [ "$alpha_ns" = "$(nsino /run/netns/exhibit-alpha.test)" ]
assert "beta app netns == /run/netns/exhibit-beta.test"    [ "$beta_ns" = "$(nsino /run/netns/exhibit-beta.test)" ]
assert "app netns != host netns"                           [ "$alpha_ns" != "$host_ns" ]
assert "alpha netns != beta netns"                         [ "$alpha_ns" != "$beta_ns" ]
assert "write-confinement holds inside the netns"          [ "$(presult "$a3" state)" = OK -a "$(presult "$a3" release)" = EROFS ]
assert "fnox decrypts in-boundary inside the netns"        [ "$(ident "$a3" secret)" = "hello-from-fnox-alpha.test" ]

say "summary"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "${KEEP:-}" = 1 ] && printf '  KEEP=1: leaving units/netns/dirs in place\n'
[ "$FAIL" = 0 ]
