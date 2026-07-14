#!/usr/bin/env bash
#
# PROTOTYPE — throwaway. One command to prove the transparent netns credential
# proxy (Exhibit issue #12 / ADR 0001, model (a)).
#
#   ./run.sh
#
# It builds two network namespaces inside ONE rootless user namespace (no host
# root needed), wires them with a veth pair, stands up a paid HTTPS "third-party
# API", the credential proxy, and a sandboxed app, then runs six checks — one
# per acceptance criterion — and prints PASS/FAIL for each.
#
# Topology (all inside `unshare --user --map-root-user --net`):
#
#   GATEWAY netns                                     APP netns
#   ┌────────────────────────────────────────┐       ┌───────────────────────┐
#   │ upstream HTTPS :443 (real TLS)          │       │ app (client.ts)       │
#   │   weather.test 203.0.113.1              │ veth  │  HTTP_PROXY=10.0.0.1  │
#   │   unknown.test 203.0.113.3              │◀─────▶│  holds NO credential  │
#   │   secure.test  203.0.113.2              │       │  10.0.0.2             │
#   │ credential proxy 10.0.0.1:3128          │       │                       │
#   │ udp :53 responder 10.0.0.1              │       │ nft OUTPUT: allow lo, │
#   │                                         │       │  udp/53, ->:3128; DROP│
#   └────────────────────────────────────────┘       └───────────────────────┘
#
set -uo pipefail
export PATH="/sbin:/usr/sbin:$PATH"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ------------------------------------------------------------------ outer half
if [[ "${1:-}" != "--inner" ]]; then
  BUN="$(command -v bun || true)"
  [[ -x "$BUN" ]] || BUN="$(mise which bun 2>/dev/null || true)"
  [[ -x "$BUN" ]] || BUN="$(ls "$HOME"/.local/share/mise/installs/bun/*/bin/bun 2>/dev/null | tail -1)"
  [[ -x "$BUN" ]] || { echo "bun not found"; exit 1; }
  WORK="$(mktemp -d)"; export WORK
  trap 'rm -rf "$WORK"' EXIT

  # Generate a throwaway CA + a server cert covering all three upstream names.
  # The CA stands in for a public CA the app/proxy already trust.
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/ca.key" -out "$WORK/ca.crt" \
    -days 2 -subj "/CN=Exhibit PoC CA" >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes -keyout "$WORK/srv.key" -out "$WORK/srv.csr" \
    -subj "/CN=exhibit-upstreams" >/dev/null 2>&1
  printf 'subjectAltName=DNS:weather.test,DNS:secure.test,DNS:unknown.test\n' > "$WORK/san.cnf"
  openssl x509 -req -in "$WORK/srv.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" \
    -CAcreateserial -days 2 -extfile "$WORK/san.cnf" -out "$WORK/srv.crt" >/dev/null 2>&1

  cat > "$WORK/hosts" <<EOF
127.0.0.1 localhost
10.0.0.1 proxy.internal
203.0.113.1 weather.test
203.0.113.2 secure.test
203.0.113.3 unknown.test
EOF

  export BUN DIR
  export CA="$WORK/ca.crt" CERT="$WORK/srv.crt" KEY="$WORK/srv.key"
  export HOSTS="$WORK/hosts" PROXY_LOG="$WORK/proxy-audit.log"
  export NODE_EXTRA_CA_CERTS="$CA"

  exec unshare --user --map-root-user --net --mount --fork --pid --mount-proc \
    bash "$DIR/run.sh" --inner
fi

# ------------------------------------------------------------------ inner half
# (now uid 0 inside a fresh user+net+mount+pid namespace)

PASS=0; FAIL=0
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓ PASS\033[0m  %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗ FAIL\033[0m  %s\n' "$*"; FAIL=$((FAIL+1)); }
in_app(){ ip netns exec app "$@"; }

say "0. build namespaces, veth, addressing"
mount --make-rprivate / 2>/dev/null || true
mount -t tmpfs none /run
mkdir -p /run/netns
mount --bind "$HOSTS" /etc/hosts
ip link set lo up
ip netns add app
ip link add veth-gw type veth peer name veth-app
ip link set veth-app netns app
ip addr add 10.0.0.1/24 dev veth-gw
ip addr add 203.0.113.1/32 dev veth-gw
ip addr add 203.0.113.2/32 dev veth-gw
ip addr add 203.0.113.3/32 dev veth-gw
ip link set veth-gw up
in_app ip link set lo up
in_app ip addr add 10.0.0.2/24 dev veth-app
in_app ip link set veth-app up
in_app ip route add default via 10.0.0.1
echo "  gateway 10.0.0.1 (+203.0.113.1/2/3)  <-veth->  app 10.0.0.2"

say "1. start upstream HTTPS API + proxy (gateway netns)"
CERT="$CERT" KEY="$KEY" "$BUN" "$DIR/upstream.ts" &
UP=$!
# The proxy must NOT itself sit behind a proxy, or its TLS origination loops.
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  PROXY_LOG="$PROXY_LOG" NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS" \
  "$BUN" "$DIR/proxy.ts" &
PX=$!
trap 'kill $UP $PX 2>/dev/null' EXIT

# wait for both listeners
for target in 203.0.113.1:443 10.0.0.1:3128; do
  h=${target%:*}; p=${target#*:}
  for _ in $(seq 1 50); do
    (exec 3<>/dev/tcp/$h/$p) 2>/dev/null && { exec 3>&- 3<&-; break; }
    sleep 0.1
  done
done
echo "  upstream + proxy up"

say "2. install fail-closed egress rules in the app netns"
# The guarantee: the app netns may reach ONLY the proxy and DNS; everything else
# is dropped. This does not depend on the app cooperating with HTTP_PROXY.
in_app iptables-nft -A OUTPUT -o lo -j ACCEPT
in_app iptables-nft -A OUTPUT -p udp --dport 53 -j ACCEPT
in_app iptables-nft -A OUTPUT -p tcp --dport 53 -j ACCEPT
in_app iptables-nft -A OUTPUT -p tcp -d 10.0.0.1 --dport 3128 -j ACCEPT
in_app iptables-nft -A OUTPUT -j DROP
in_app iptables-nft -S OUTPUT | sed 's/^/  /'

# app-side env: Exhibit injects the proxy; the app also trusts the CA (as it
# would any public CA) so it can validate secure.test end-to-end over the tunnel.
PXENV=(env HTTP_PROXY=http://10.0.0.1:3128 HTTPS_PROXY=http://10.0.0.1:3128 \
       NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS")

say "CHECK 1 — app calls http://weather.test/api holding NO credential; proxy attaches it + originates real TLS"
out=$(in_app "${PXENV[@]}" "$BUN" "$DIR/client.ts" http://weather.test/api 2>/dev/null)
echo "$out" | sed 's/^/    /'
if grep -q 'HTTP 200' <<<"$out" && grep -q '"ok":true' <<<"$out" && grep -q 'PROXYHELD' <<<"$out"; then
  ok "upstream returned 200 authed_as the proxy-held M2M token; app never sent it"
else
  bad "expected 200 with the injected M2M credential"
fi

say "CHECK 2 — proxy emits metadata log line and NEVER logs the credential"
line=$(grep '"dst_host":"weather.test"' "$PROXY_LOG" | grep '"cred_attached":true' | tail -1)
echo "    $line"
if grep -q '"method":"GET"' <<<"$line" && grep -q '"path":"/api"' <<<"$line" \
   && grep -q '"status":200' <<<"$line" && grep -q '"dst_host":"weather.test"' <<<"$line" \
   && grep -q '"app":"weather-app.exhibit.test"' <<<"$line"; then
  secret_hits=$(grep -c 'PROXYHELD' "$PROXY_LOG")
  if [[ "$secret_hits" == "0" ]]; then
    ok "log has {ts,app,dst_host,method,path,status,bytes}; credential value appears 0 times in the whole log"
  else
    bad "credential value leaked into the audit log ($secret_hits hits)"
  fi
else
  bad "metadata log line missing required fields"
fi

say "CHECK 3 — a request carrying the app's OWN Authorization passes through untouched (never-overwrite)"
out=$(in_app "${PXENV[@]}" USER_TOKEN="Bearer user_delegated_abc123XYZ" \
        "$BUN" "$DIR/client.ts" http://weather.test/api 2>/dev/null)
echo "$out" | sed 's/^/    /'
if grep -q 'abc123XYZ' <<<"$out" && ! grep -q 'PROXYHELD' <<<"$out"; then
  ok "upstream saw the user-delegated token, not the M2M token — proxy did not overwrite"
else
  bad "never-overwrite violated (M2M token replaced the app's own auth)"
fi

say "CHECK 4 — a non-declared host gets NO credential (declared-upstreams-only)"
out=$(in_app "${PXENV[@]}" "$BUN" "$DIR/client.ts" http://unknown.test/api 2>/dev/null)
echo "$out" | sed 's/^/    /'
if grep -q '"got_auth":null' <<<"$out"; then
  ok "unknown.test is routable but not in the M2M set — proxy attached nothing"
else
  bad "a credential was attached to an undeclared host"
fi

say "CHECK 5 — FAIL-CLOSED: a direct connection that bypasses the proxy has no egress (DNS excepted)"
# Bypass: talk straight to the real upstream IP:443, NOT through the proxy.
if in_app env -u HTTP_PROXY -u HTTPS_PROXY curl -sS --noproxy '*' --max-time 3 \
     https://weather.test/api >/dev/null 2>&1; then
  bad "direct egress to the upstream succeeded — NOT fail-closed"
else
  echo "    direct https://weather.test/api (no proxy) -> blocked/timed out"
  # DNS is the sanctioned exception: a udp/53 datagram still gets out.
  dns=$(in_app timeout 3 bash -c 'exec 3<>/dev/udp/10.0.0.1/53; printf q >&3; head -c 12 <&3' 2>/dev/null)
  echo "    udp/53 probe reply: '${dns:-<none>}'"
  if [[ "$dns" == "DNS-REPLY-OK" ]]; then
    ok "direct egress dropped by the netns (not by app cooperation); only DNS escapes"
  else
    bad "DNS exception did not behave as expected"
  fi
fi

say "CHECK 6 — an https:// call is an opaque CONNECT tunnel: thin-logged, NO credential (documented limit)"
out=$(in_app "${PXENV[@]}" "$BUN" "$DIR/client.ts" https://secure.test/data 2>/dev/null)
echo "$out" | sed 's/^/    /'
tlog=$(grep '"dst_host":"secure.test"' "$PROXY_LOG" | grep '"tunnelled":true' | tail -1)
echo "    tunnel log: $tlog"
if grep -q '"secured":true' <<<"$out" && grep -q '"saw_auth":null' <<<"$out" \
   && [[ -n "$tlog" ]] && ! grep -q '"path"' <<<"$tlog"; then
  ok "secure.test (declared!) still got no credential over TLS; log has bytes only, no path/method/status"
else
  bad "https tunnel behaved unexpectedly"
fi

say "RESULT: $PASS passed, $FAIL failed"
[[ "$FAIL" == "0" ]] && echo "ALL CRITERIA PROVEN" || echo "SOME CHECKS FAILED"
exit $((FAIL > 0))
