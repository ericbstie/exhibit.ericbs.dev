# netns basic-auth interception

A minimal proof-of-concept for one of Exhibit's headline features: *"proxy
requests & attach auth from outside the webapp sandboxes."* A sandboxed app
talks to a paid API with **no credentials of its own**; the host attaches Basic
auth transparently at the network-namespace boundary.

## Pieces

| File | Role | Port |
|------|------|------|
| `weather-api.ts` | Commercial "weather" API. Requires HTTP Basic auth. Only endpoint `GET /sunny` → `{"sunny": true\|false}` at random. | 1234 |
| `client.ts` | The sandboxed webapp. Fetches `/sunny` and relays it, attaching **no** auth. | 9999 |
| `interceptor.ts` | Auth-injecting transparent proxy. Adds the `Authorization` header the client never sent, forwards to the real API. | 8888 |
| `run-netns-test.sh` | Builds the namespace, wires everything, and demonstrates before/after. | — |

## How the interception works

```
default ns                         netns "wns"
weather-api :1234  <──veth──>  client :9999   (fetches 10.200.1.1:1234/sunny, no auth)
10.200.1.1                     10.200.1.2
                                     │
                                     │ iptables -t nat OUTPUT:
                                     │   :1234 ─REDIRECT─> :8888
                                     ▼
                               interceptor :8888  (uid `intercept`)
                                     │ injects Authorization: Basic …
                                     └─> real weather-api :1234
```

1. The client runs inside network namespace `wns` and believes the weather API
   lives at `10.200.1.1:1234` (the host end of a veth pair). It sends no auth.
2. An `iptables` `nat/OUTPUT` **REDIRECT** rule inside the namespace bends all
   outbound `:1234` traffic to the local interceptor on `:8888`.
3. The interceptor injects `Authorization: Basic …` and forwards to the real
   API.
4. To avoid an infinite loop, the interceptor runs as its own uid and an
   `owner --uid-owner` **RETURN** rule exempts *its* forwarding connection from
   the redirect.

The client binary is never modified and never holds the secret — exactly the
sandbox property Exhibit wants.

## Run it

```bash
sudo ./run-netns-test.sh   # needs root/CAP_NET_ADMIN for netns + iptables
```

Expected: step 4 returns **401** (client alone, no auth), step 7 returns **200**
with a random `sunny` value (interceptor attached auth), step 8 flushes the
redirect and returns **401** again — proving the credentials only ever existed
in the interceptor. The script cleans up the namespace and veth on exit.

### Requirements

`iproute2` (`ip`), `iptables`, `bun`, and root. The script copies the real
`bun` binary to `/opt/bun-shared` so the unprivileged `intercept` user can
execute it (the default install symlinks into root's `0700` home).
