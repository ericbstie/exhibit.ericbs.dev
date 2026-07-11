# Exhibit — research report

*2026-07-10, updated 2026-07-11. Combines web research (all claims verified against project docs/READMEs, links inline) with hands-on experiments run in a Linux sandbox (Firecracker microVM, custom kernel 6.18, root, user namespaces available). Experiment transcripts are summarized in [§4](#4-what-i-actually-tested-and-what-happened); [§4.5](#45-sandbox-artifact-audit-which-of-my-negative-findings-are-real) audits which negative findings were artifacts of the test sandbox itself.*

## TL;DR

1. **Exhibit does not already exist.** No tool combines: deploy-an-arbitrary-command to your own VPS + auto TLS + non-container sandboxing + egress proxy with secret injection + DNS adaptors. Every piece exists somewhere; the combination exists nowhere.
2. **Lakebed is not it** — it's a *managed hosted runtime* for AI-built TypeScript "capsules" on lakebed.app subdomains, not a self-host-on-your-VPS tool. But its security philosophy (restricted runtime, gated outbound fetch, platform-held secrets) is strikingly close to exhibit's, which validates the idea.
3. **The defensible core is the egress/secrets proxy, not the deploy UX.** One-command deploys, auto TLS, and dashboards are commodity (Coolify, Dokploy, Kamal, Sidekick…). No self-hosted PaaS audits outbound traffic or brokers secrets outside the app. That is the wedge.
4. **The architecture works.** I built and verified the full chain in a sandbox: Caddy (dynamic admin-API routes) → Unix socket → bubblewrap sandbox with **zero network** → egress only via an allowlisting, secret-injecting proxy socket. The app never sees the secret, denied hosts get 403, and every outbound request lands in an audit log.
5. **Do not bet on any single sandbox mechanism.** Landlock (what mise uses for FS) was *missing* on my 6.18 test kernel — though §4.5 shows that was the test sandbox's custom kernel, and stock distro kernels do ship it. Kernel config, not version, decides; exhibit still needs a detect-and-degrade ladder: systemd hardening → +Landlock → bwrap fallback.

---

## 1. Does exhibit already exist?

### Lakebed (the closest thing you found)

[lakebed.dev](https://lakebed.dev/) / [docs.lakebed.dev](https://docs.lakebed.dev/) — an "agent-native" CLI + **hosted cloud runtime** for small full-stack TypeScript apps ("capsules"). Anonymous deploys run in a **restricted JS runtime** (language-level sandbox, not containers) with **outbound fetch disabled**; "claiming" a deploy unlocks server env vars and outbound fetch, with secrets held platform-side and never embedded in artifacts.

- **Overlap:** non-container restricted runtime, gated egress, platform-held secrets, CLI logs. The philosophy is exhibit's philosophy.
- **Differences:** it's *their* cloud, not your VPS. Lakebed-owned subdomains only — no custom domains/TLS/DNS story. Only runs Lakebed-shaped TS capsules, not `-- mise run production`. Egress is on/off per deploy, **not** a per-request injection/allowlist proxy. No published self-hosting path or canonical open-source repo for the platform.

**Verdict: same instincts, different product.** Exhibit = "lakebed's security model, but self-hosted, for arbitrary run commands, with real domains."

### The rest of the landscape (summary of full sweep)

| Tool | Containers? | Egress audit / secret proxy | Notes |
|---|---|---|---|
| [Coolify](https://github.com/coollabsio/coolify) (58k★) | Yes | None | Heavy control plane (~2GB RAM); secrets = env vars in the app |
| [Dokploy](https://github.com/Dokploy/dokploy) (36k★) | Yes | None | |
| [Dokku](https://github.com/dokku/dokku) (32k★) | Yes | None | TLS via plugin, CLI-only |
| [CapRover](https://github.com/caprover/caprover) (15k★) | Yes | None | Slowing |
| [Kamal](https://kamal-deploy.org/) (14k★) | Yes | None (kamal-proxy is inbound-only) | Wrote its own proxy from scratch — instructive |
| [Piku](https://github.com/piku/piku) (6.6k★) | **No** | None | The only no-Docker PaaS of note — and it has **zero isolation** (shared unix user) |
| [Sidekick](https://github.com/MightyMoud/sidekick) (7.5k★) | Yes | Secrets encrypted at rest but still injected into app env | Closest CLI UX; solo maintainer, slowing |
| [Cosmos Cloud](https://github.com/azukaar/Cosmos-Server) (6k★) | Yes | Inbound-only (SmartShield anti-bot/DDoS) | Closest "security by default" positioning |
| [Cloudron](https://www.cloudron.io/) | Yes | None | **Only tool with real DNS automation** — and it's proprietary, 2-app free cap |

Egress-with-secret-injection *does* exist — but never inside a deploy tool:

- [CyberArk Secretless Broker](https://github.com/cyberark/secretless-broker) — canonical prior art since 2017, actively maintained, enterprise/K8s DNA, zero hobbyist ergonomics.
- [stripe/smokescreen](https://github.com/stripe/smokescreen) — battle-tested CONNECT egress proxy with host ACLs and private-IP (SSRF) blocking. Audits, doesn't inject. **Copy its SSRF defense.**
- [zerobox](https://github.com/afshinm/zerobox) — bwrap+seccomp sandbox CLI with `--secret KEY=v --secret-host KEY=api.example.com`: app sees a placeholder, bundled proxy substitutes the real value for approved hosts. **Exhibit's proxy idea, working today** — but a sandbox CLI, not a deploy platform.
- [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) — bwrap with netns fully removed + proxies over Unix sockets + optional MITM CA. The exact pattern I verified below.
- [Gondolin](https://earendil-works.github.io/gondolin/secrets/) (microVMs + placeholder-token substitution), [Latchkey](https://github.com/imbue-ai/latchkey), Cloudflare Sandboxes "[Outbound Workers](https://blog.cloudflare.com/sandbox-auth/)", [LangSmith Auth Proxy](https://www.langchain.com/blog/how-auth-proxy-secures-network-access-for-langsmith-agent-sandboxes) — all AI-agent-sandbox tools or managed cloud, none self-hosted deploy platforms.
- Validation of the thesis: HN front page, "[Some secret management belongs in your HTTP proxy](https://news.ycombinator.com/item?id=47825888)" — commenters could only name sandbox tools, no PaaS.

### Where exhibit is redundant vs. differentiated

**Redundant (table stakes — don't market these):** one-command deploy, auto TLS + custom domains, dashboard/logs/health, "free & open source" (Coolify/Dokku/Piku/Kamal are all forever-free).

**Genuine gaps exhibit can own:**
1. **Egress audit + secret injection in a deploy tool** — verified absent from every tool in the table. Honest claim: *"first to integrate secretless credential brokering + egress auditing into a hobbyist deploy tool"* (not "invented the pattern" — Secretless Broker is 2017).
2. **Non-container sandboxing as a product feature** — Piku is the only no-Docker option and does none.
3. **DNS record automation** in an open-source hobbyist tool — only proprietary Cloudron does this today.
4. **Wrapping an arbitrary run command** (`ex deploy -- mise run production`) — everything else is git-push/buildpack/Dockerfile-centric.

The AI-generated-code wave is the tailwind narrative: hobbyists increasingly deploy semi-trusted code they didn't write; they're exactly the users who need egress protection and will never configure Conjur.

---

## 2. Steer away from

- **Building your own DNS adaptor interface.** [libdns](https://github.com/libdns/libdns) *is* that interface (Get/Append/Set/DeleteRecords over ~100 providers) and it's what Caddy's DNS plugins wrap. Consume it directly; same provider creds feed exhibit and Caddy's DNS-01 challenge. Bonus: [mholt/caddy-dynamicdns](https://github.com/mholt/caddy-dynamicdns) keeps A/AAAA records pointed at the VPS for free.
- **Embedding Caddy as a Go library.** Couples exhibit's lifecycle to the proxy (an `ex` crash drops all traffic), inherits Caddy's dependency tree and global state. Run a pinned xcaddy-built binary and drive the admin API — verified trivial (§4.1).
- **`caddy add-package` at runtime** — depends on Caddy's build service, and there's an [open proposal to remove it](https://github.com/caddyserver/caddy/issues/7010). Pin a custom build in CI instead.
- **caddyserver/forwardproxy for the egress role.** It can't MITM (CONNECT-tunnels opaquely → can't inject or audit HTTPS bodies), targets censorship circumvention, and is seeking maintainers. Use [elazarl/goproxy](https://github.com/elazarl/goproxy) (or copy smokescreen) for a purpose-built egress component instead.
- **Assuming Landlock exists.** Kernel config / LSM boot list decides, not kernel version — my 6.18 test kernel had `CONFIG_SECURITY_LANDLOCK` unset and mise's FS sandbox hard-errored. **Caveat (see §4.5): that was a custom-built sandbox kernel; stock [Ubuntu 22.04+, Debian 12+, Fedora 35+ enable Landlock by default](https://docs.suricata.io/en/latest/configuration/landlock.html)** ([Ubuntu's enabling patch](https://patchwork.ozlabs.org/project/ubuntu-kernel/patch/20211203185226.1957311-2-mic@digikod.net/)), so on mainstream VPS images it will normally be there. The advice stands in softened form: detect at runtime (`landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`), degrade gracefully, and remember Landlock *network* rules still need kernel ≥ 6.7 (Debian 12's 6.1 has FS-only).
- **mise's sandbox as *the* sandbox.** Verified on Linux: `--allow-net=<host>` **is not enforced** (help text: "macOS only in v1; on Linux falls back to allowing all network") and `--deny-net` is all-or-nothing seccomp. It composes nicely as an *inner* layer (§4.4) but can't express "network only via my proxy" — exhibit's whole point.
- **firejail** — setuid-root attack surface, multiple CVEs incl. local root (CVE-2022-31214). Wrong tool for multi-tenant servers.
- **Relying on `HTTP_PROXY` env vars alone.** Cooperative only; any raw socket bypasses it. Fine as the *steering* mechanism, but pair it with a hard block (netns or systemd `IPAddressDeny`) so bypass = connection refused, not escape. This is exactly what zerobox and sandbox-runtime do.
- **Transparent HTTPS interception without opt-in thinking.** Injecting secrets into HTTPS requires either a MITM CA trusted inside the sandbox (breaks cert-pinning clients; need an exclude list) or zerobox/secretless-style "app speaks plain HTTP to localhost, proxy does TLS upstream". Plan for both modes; don't assume MITM everywhere.
- **Long Unix socket paths** — hit this live: AF_UNIX paths cap at ~108 chars (`OSError: AF_UNIX path too long`). Put sockets in `/run/exhibit/<app>/`.

---

## 3. Recommended architecture

**Process model:** `ex` daemon (root, systemd unit) + pinned xcaddy-built Caddy (`caddy run --resume`) + one goproxy-based egress proxy owned by `ex` + one systemd unit per app.

**Ingress:** exhibit's app DB is the source of truth → render full Caddy JSON and `POST /load` (idempotent, zero-downtime; the [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy) model), with `@id`-tagged routes if surgical updates are ever needed (verified working, §4.1). TLS: wildcard cert via DNS-01 for `*.<base-domain>` + [On-Demand TLS](https://caddyserver.com/docs/automatic-https) with the `permission` endpoint served by `ex` (200 iff domain is a deployed app) for custom domains — the standard SaaS pattern.

**Sandbox fallback ladder** (detect at deploy time, report in dashboard):
1. **systemd unit + Landlock v4+** (kernel ≥ 6.7): `DynamicUser`/pinned user, `ProtectSystem=strict`, `ReadWritePaths=`, `MemoryMax`/`CPUQuota`/`TasksMax`, `IPAddressDeny=any` + `IPAddressAllow=localhost`, plus a Landlock shim allowing TCP connect only to the proxy port.
2. **systemd unit alone** (any systemd ≥ 249 VPS): still gives read-only FS, loopback-only network, resource limits — already a credible sandbox, zero extra binaries.
3. **bwrap mode** (no systemd / weird hosts): `--unshare-all` + Unix-socket plumbing — fully verified below.

**Egress:** apps get `HTTP_PROXY`/`HTTPS_PROXY` (+ `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS` when MITM enabled) pointing at exhibit's proxy; kernel-level block (netns or `IPAddressDeny`) guarantees the proxy is the only path. Proxy does: per-app identity, host allowlists, **private-IP/SSRF rejection (steal from smokescreen)**, structured audit log, secret injection (CONNECT by default, MITM or placeholder-substitution when injection is on).

**DNS:** libdns providers directly in `ex`; optional caddy-dynamicdns.

**Why not `--enable-network-monitoring` as a flag that changes proxying on/off?** Consider making *blocked-by-default with allowlist* the default instead — every prior-art tool converged on deny-by-default, and "monitoring optional" forfeits the differentiator on the default path.

---

## 4. What I actually tested (and what happened)

Environment (fingerprinted after the fact, see §4.5): a **Firecracker microVM running a real, custom-built Linux 6.18.5 kernel** (`builder@sandboxing`, `--firecracker-init` on the boot cmdline) — *not* gVisor or another syscall emulator, so kernel-behavior results are genuine. Root, user namespaces available, **Landlock absent** (`# CONFIG_SECURITY_LANDLOCK is not set` — a choice of this sandbox's kernel, not of stock distros), LSM list `capability,selinux`, cgroups in a hybrid nonstandard layout, custom init instead of systemd PID 1, IPv6 disabled, and **all egress forced through a credential-injecting MITM proxy** (more on that delightful irony in §4.5).

### 4.1 Caddy dynamic orchestration — ✅ works, trivially

- Started `caddy run` with a minimal JSON config (`admin` on :2019, one empty server).
- `POST /config/apps/http/servers/exhibit/routes` with an `@id`-tagged host-matched reverse-proxy route → routing live instantly, no restart.
- **Auto-HTTPS kicked in on its own** the moment a route had a host matcher (had to disable it for plain-HTTP testing — in production this is exactly the wanted behavior).
- `PATCH /id/app-x/handle/0/upstreams` → upstream swapped live (verified traffic moved). `DELETE /id/app-x` → route gone. This is the whole per-app lifecycle in three HTTP calls.
- Gotchas found: POSTing a duplicate `@id` poisons subsequent config indexing until cleaned up — the render-full-config + `POST /load` model avoids this class entirely; unmatched hosts return an empty 200 by default (add a terminal catch-all route).

### 4.2 bubblewrap sandboxing — ✅ works, unprivileged-capable

```
bwrap --ro-bind /usr /usr ... --ro-bind $APP /app --tmpfs /tmp --proc /proc --dev /dev \
      --unshare-all --clearenv ... python3 /app/server.py
```
- App served HTTP normally; `/root/host-secret.txt` invisible (`ENOENT`); writes to the ro-bound app dir refused (`EROFS`); app sees a 7-entry root filesystem.
- `--die-with-parent` is a footgun for a supervisor that respawns shells — the app dies with the launching process (bit me mid-test). Fine when `ex` is a long-lived daemon; just know the semantics.

### 4.3 Zero-network sandbox + Unix-socket ingress/egress — ✅ the whole exhibit core loop works

The sandbox-runtime/zerobox pattern, reproduced end-to-end:

- App under `bwrap --unshare-all` (**no network interfaces at all**, `/sys/class/net` absent), serving HTTP **over a Unix socket** bind-mounted out of the sandbox. Direct egress fails.
- Caddy `reverse_proxy` upstream `"dial": "unix//run/exhibit/.../app.sock"` → **Caddy reaches the netns-less app perfectly.** Ingress solved with zero network in the sandbox.
- Egress proxy (~40-line Python stand-in for goproxy) listening on a Unix socket bind-mounted **into** the sandbox; inside, `socat` bridges `127.0.0.1:9911` → that socket; `HTTP_PROXY=http://127.0.0.1:9911`.
- Result, all verified by request/response:
  - app env contains **no secrets** (checked from inside);
  - `GET http://api.internal/whoami` via proxy → upstream saw `Authorization: Bearer REAL-SECRET-42` **injected by the proxy** (proxy-side DNS/upstream mapping too — the sandbox never resolves names);
  - `GET http://evil.example.com` → **403 from the proxy**;
  - every request logged: `{"host": "evil.example.com", "verdict": "DENY"}` / `{"host": "api.internal", "verdict": "ALLOW+INJECT"}`.
- Full chain in one request: `curl -H 'Host: myapp.local' → Caddy → unix socket → sandboxed app → proxy socket → secret-injected API call` — worked.
- Gotcha: AF_UNIX ~108-char path limit (hit it live; use `/run/exhibit/`).

### 4.4 mise experimental sandbox — ⚠️ works partially, composes nicely, can't be the outer layer

With `mise settings experimental=true` (v2026.7.5):

- `--deny-write` / `--deny-read` → **hard error on this machine**: `failed to apply landlock restrictions: landlock: NotImplemented`. (Fail-closed here, contradicting docs' "warn and run unsandboxed" — either way, FS sandboxing is kernel-config-dependent.)
- `--deny-net` → **worked** (seccomp blocks inet socket creation; DNS fails, loopback TCP fails).
- `--allow-net=<host>` → documented as **not enforced on Linux** (falls back to allow-all).
- **Best finding:** under `mise x --deny-net`, inet is blocked but **Unix sockets still work** — a curl through exhibit's proxy socket succeeded, secret injected, while direct TCP was refused. So a user's `mise run production` with mise's sandbox *composes* with exhibit's proxy: mise provides defense-in-depth inside, exhibit provides the only network path outside. (Note: the socat TCP bridge can't run under mise's seccomp — clients must speak to the Unix socket directly in that combo.)

### 4.5 Sandbox-artifact audit: which of my negative findings are real?

I fingerprinted the test environment (`/proc/version`, boot cmdline, mounted securityfs, kernel config, proxy env) to separate "true of Linux" from "true of this sandbox":

**Artifacts of the sandbox — do NOT generalize these:**

| Finding above | Why it's an artifact | Expected on a real VPS |
|---|---|---|
| Landlock `ENOSYS` / mise FS sandbox hard-errors | Custom Firecracker guest kernel with `# CONFIG_SECURITY_LANDLOCK is not set` (LSM list: `capability,selinux` only) | Stock Ubuntu 22.04+ / Debian 12+ / Fedora 35+ [enable Landlock by default](https://docs.suricata.io/en/latest/configuration/landlock.html); mise's FS sandbox and ladder-step 1 should work. Verify with `mise x --deny-write -- true` during `ex` setup |
| Couldn't test systemd sandboxing | Custom `rdinit=/process_api` init, no systemd PID 1 — a microVM design choice | Every mainstream VPS image boots systemd; `IPAddressDeny`/`DynamicUser`/`MemoryMax` untested here but unblocked there |
| Couldn't test cgroup resource limits | Hybrid/nonstandard cgroup mount in this guest | Standard cgroup v2 on modern distros |
| Couldn't test ACME / On-Demand TLS / any real outbound behavior | No public IP/domain; IPv6 disabled; **all egress is forced through the environment's own MITM proxy** with a private CA | Fully testable on a VPS with a domain |

**Findings that DO transfer** (the guest kernel is a real Linux 6.18, not gVisor — syscalls are genuine): everything that *worked*. Caddy admin-API orchestration (pure userspace), bwrap namespaces/ro-binds/`--unshare-all`, Unix sockets crossing netns boundaries, the AF_UNIX ~108-char path limit, mise's seccomp `--deny-net` blocking inet while passing Unix sockets, and mise's documented (not environment-dependent) Linux `--allow-net` fallback.

**The irony that doubles as validation:** the sandbox I ran these tests in — Anthropic's remote-execution environment — *is* exhibit's proposed architecture, deployed in production. It's a Firecracker microVM whose env contains literal placeholder credentials (`GH_TOKEN=proxy-injected`, `CLOUDSDK_AUTH_ACCESS_TOKEN=proxy-injected`) with a mandatory local egress proxy at `127.0.0.1:38821` that substitutes real tokens on the way out, steered by `HTTPS_PROXY`/`NO_PROXY`/per-toolchain env vars and a distributed MITM CA bundle (`SSL_CERT_FILE`, Java truststore, npm/yarn/docker configs). Real workloads (git, npm, gcloud, Java) run happily inside it — proof the env-var-steered, proxy-side-credential model works with unmodified tooling at production scale. Worth studying its DX details: per-toolchain proxy env vars and a pre-baked CA bundle are exactly the polish exhibit's sandbox needs.

### What I could not test here

- systemd unit sandboxing (`IPAddressDeny`, `DynamicUser`, `MemoryMax`) — no systemd PID 1 in this container. The research (ArchWiki, systemd docs) says this is the strongest spine on a real VPS; needs verification on an actual VPS before committing.
- Real ACME issuance / On-Demand TLS (no public domain reachable from here) — pattern is extensively documented ([Caddy On-Demand TLS](https://caddyserver.com/on-demand-tls), [Pirsch write-up](https://pirsch.io/blog/how-we-use-caddy-to-provide-custom-domains-for-our-clients/)).
- HTTPS MITM injection (only plain-HTTP injection tested). goproxy's `AlwaysMitm` + a generated CA in `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS` is the documented path; cert-pinning clients need a CONNECT-tunnel exclude list.

---

## 5. VPS compatibility: "does Hetzner block this?" (2026-07-11)

Concern raised: VPSes (Hetzner specifically) disallow virtualization — does that break the sandbox plan?

**No — the plan never used virtualization.** What Hetzner Cloud blocks is *nested* virtualization: you can't run KVM-based VMs (QEMU, Firecracker, kubevirt) inside a cloud instance ([confirmed limitation](https://github.com/RedHat-EMEA-SSA-Team/hetzner-ocp/issues/10), [community reports](https://www.webhostingtalk.com/showthread.php?t=1888802)). Everything in the recommended ladder is a **kernel feature of your own guest kernel**, not virtualization:

| Mechanism | Needs virtualization? | Works on Hetzner Cloud? |
|---|---|---|
| Linux users + file permissions | No | Yes — the zeroth rung; `DynamicUser=` automates exactly this |
| systemd hardening (`ProtectSystem`, `IPAddressDeny`, `MemoryMax`…) | No (cgroups/eBPF/namespaces) | Yes |
| Landlock, seccomp | No (syscall-level LSM/filters) | Yes (stock Ubuntu/Debian kernels) |
| bubblewrap / unshare (namespaces) | No — same primitive Docker uses, and Docker famously runs fine on Hetzner | Yes |
| **nsjail** | No (namespaces + seccomp + cgroups + rlimits) | Yes |
| gVisor | Not on its default **systrap/ptrace** platform (only the optional KVM platform needs nested virt) | Yes, with `--platform=systrap` |
| Firecracker / QEMU microVMs | **Yes — this is the one thing that's off the table** | No (cloud); yes on Hetzner dedicated |

The confusion is understandable: my *test environment* was a Firecracker microVM, and tools like Gondolin use microVMs. But exhibit's ladder (systemd → Landlock → bwrap) was chosen precisely because it's kernel-native. A KVM cloud VPS gives you a full private kernel — namespaces, LSMs, and cgroups are all yours. (It's OpenVZ/LXC-era *container* VPSes where namespaces get restricted; Hetzner Cloud is KVM.)

**On nsjail specifically:** it would work (namespaces + seccomp-bpf + cgroups + rlimits, config-file driven, actively used for CTF/exec sandboxes, supports veth into the jail). It's a reasonable alternative to bwrap with more knobs (per-jail resource limits built in, protobuf configs). Trade-offs: usually built from source (thin distro packaging), Google-maintained but not "supported", and it overlaps heavily with what systemd already provides once exhibit generates units. Recommendation unchanged: **systemd units as the spine** (users/cgroups/network lockdown declaratively, zero extra binaries), bwrap *or* nsjail as the non-systemd fallback — pick one; both are namespace-based and Hetzner-safe.

**One real Ubuntu caveat in this area:** Ubuntu 23.10+ restricts *unprivileged* user-namespace creation via AppArmor (`apparmor_restrict_unprivileged_userns=1`). This hits unprivileged bwrap/nsjail invocations with `Permission denied` — the kind of failure easily misread as "VPS blocks sandboxing." Exhibit's daemon runs as root, so it's mostly moot (root creates the sandbox, then drops privileges), but if apps are launched as plain users, ship an AppArmor profile or flip the sysctl during `ex` setup.

## 6. Suggested next steps

1. Verify the systemd ladder on a real VPS (Ubuntu 24.04: kernel 6.8 = Landlock v4): one generated unit with `IPAddressDeny=any` + proxy env vars, confirm a Node/Python app works unmodified.
2. Prototype `ex-egress` in Go on goproxy: host allowlist, smokescreen-style private-IP rejection, JSONL audit log, per-app auth (distinct socket per app — you get identity for free).
3. Prototype `ex` config rendering → `POST /load`, with the On-Demand TLS `permission` endpoint.
4. Study zerobox's placeholder-secret UX (`ZEROBOX_SECRET_…` substitution) — it may be better DX than MITM for the common case.
5. Positioning: lead with *"your deployed app never holds a secret and can't phone home without you seeing it"* — that sentence is true of no other self-hostable deploy tool today.
