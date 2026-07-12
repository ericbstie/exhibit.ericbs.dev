#!/usr/bin/env bash
#
# Demonstrate intercepting a namespaced client's outbound HTTP and attaching
# Basic auth it never sent — using a Linux network namespace + iptables REDIRECT
# + a small auth-injecting proxy.
#
# Topology:
#
#   default ns                         netns "wns"
#   ┌───────────────────────┐          ┌────────────────────────────────────┐
#   │ weather-api :1234      │          │ client :9999                       │
#   │   (needs Basic auth)   │          │   fetch http://10.200.1.1:1234/sunny│
#   │                        │  veth    │      (NO auth)                     │
#   │ veth-host 10.200.1.1 <─┼──────────┼─> veth-ns 10.200.1.2               │
#   │                        │          │                                    │
#   │                        │          │ iptables OUTPUT nat:               │
#   │                        │          │  :1234 ─REDIRECT─> :8888            │
#   │                        │          │ interceptor :8888 (uid intercept)  │
#   │                        │          │  injects auth, forwards to :1234    │
#   └───────────────────────┘          └────────────────────────────────────┘
#
set -euo pipefail

NS=wns
HOST_IP=10.200.1.1
NS_IP=10.200.1.2
SUBNET=24
VETH_HOST=veth-host
VETH_NS=veth-ns
REDIRECT_PORT=8888
INTERCEPT_USER=intercept
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# bun must live somewhere a non-root user can both traverse to AND execute.
# The default install is a symlink into root's $HOME (0700), which the
# unprivileged interceptor user cannot reach, so copy the REAL binary to /opt.
BUN=/opt/bun-shared
REAL_BUN="$(readlink -f "$(command -v bun || echo /root/.bun/bin/bun)")"
if [ ! -x "$BUN" ] || [ "$BUN" -ot "$REAL_BUN" ]; then
  cp "$REAL_BUN" "$BUN"
  chmod 0755 "$BUN"
fi

PIDS=()

cleanup() {
  echo
  echo "=== cleanup ==="
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  ip netns pids "$NS" 2>/dev/null | xargs -r kill 2>/dev/null || true
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$VETH_HOST" 2>/dev/null || true
  echo "done."
}
trap cleanup EXIT

echo "=== 0. prep ==="
id "$INTERCEPT_USER" &>/dev/null || useradd -r -s /usr/sbin/nologin "$INTERCEPT_USER"
INTERCEPT_UID=$(id -u "$INTERCEPT_USER")
echo "interceptor will run as $INTERCEPT_USER (uid $INTERCEPT_UID)"

# Clean any prior run.
ip netns del "$NS" 2>/dev/null || true
ip link del "$VETH_HOST" 2>/dev/null || true

echo
echo "=== 1. build namespace + veth link ==="
ip netns add "$NS"
ip link add "$VETH_HOST" type veth peer name "$VETH_NS"
ip link set "$VETH_NS" netns "$NS"

ip addr add "$HOST_IP/$SUBNET" dev "$VETH_HOST"
ip link set "$VETH_HOST" up

ip netns exec "$NS" ip addr add "$NS_IP/$SUBNET" dev "$VETH_NS"
ip netns exec "$NS" ip link set "$VETH_NS" up
ip netns exec "$NS" ip link set lo up
echo "host $HOST_IP <-> $NS_IP inside $NS"

echo
echo "=== 2. start weather API (default ns, needs auth) ==="
"$BUN" "$DIR/weather-api.ts" &
PIDS+=($!)
sleep 0.6

echo
echo "=== 3. start client INSIDE the namespace (sends no auth) ==="
ip netns exec "$NS" env WEATHER_API="http://$HOST_IP:1234" "$BUN" "$DIR/client.ts" &
PIDS+=($!)
sleep 0.6

echo
echo "=== 4. BEFORE interception: client -> weather API (expect 401) ==="
ip netns exec "$NS" curl -s "http://$NS_IP:9999/" || true

echo
echo
echo "=== 5. start interceptor INSIDE namespace as uid $INTERCEPT_UID ==="
ip netns exec "$NS" runuser -u "$INTERCEPT_USER" -- \
  env REAL_API="http://$HOST_IP:1234" "$BUN" "$DIR/interceptor.ts" &
PIDS+=($!)
sleep 0.6

echo
echo "=== 6. install iptables REDIRECT inside the namespace ==="
# Exempt the interceptor's own forwarding connection (matched by uid) so it is
# not redirected back into itself.
ip netns exec "$NS" iptables -t nat -A OUTPUT -p tcp --dport 1234 \
  -m owner --uid-owner "$INTERCEPT_UID" -j RETURN
# Everything else headed for :1234 gets bent to the local interceptor.
ip netns exec "$NS" iptables -t nat -A OUTPUT -p tcp --dport 1234 \
  -j REDIRECT --to-ports "$REDIRECT_PORT"
ip netns exec "$NS" iptables -t nat -L OUTPUT -n -v --line-numbers

echo
echo "=== 7. AFTER interception: client -> (redirect) -> interceptor -> weather API ==="
echo "--- three calls to show the random sunny result flowing through ---"
for i in 1 2 3; do
  echo "call $i:"
  ip netns exec "$NS" curl -s "http://$NS_IP:9999/"
  echo
done

echo
echo "=== 8. proof the client itself never had credentials ==="
echo "Temporarily flush the redirect and let the client hit the API raw (expect 401):"
ip netns exec "$NS" iptables -t nat -F OUTPUT
ip netns exec "$NS" curl -s "http://$NS_IP:9999/" || true
echo
echo "-> Same client code, same request. With the redirect gone it gets 401,"
echo "   proving the auth only ever came from the namespace-boundary interceptor."

echo
echo "=== test complete ==="
