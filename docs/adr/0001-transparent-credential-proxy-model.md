# 1. Transparent credential proxy — plaintext-to-proxy via forward-proxy env

- **Status:** Accepted
- **Date:** 2026-07-14
- **Deciders:** single operator (Exhibit)
- **Ticket:** [Decide: transparent credential-proxy model](https://github.com/ericbstie/exhibit.ericbs.dev/issues/8) (map: [#2](https://github.com/ericbstie/exhibit.ericbs.dev/issues/2))
- **Research:** `research/netns-proxy` branch — [netns transparent egress-proxy patterns](https://github.com/ericbstie/exhibit.ericbs.dev/issues/4)

## Context

Exhibit's headline security property is that **deployed apps never hold their own outbound
credentials**. Each app runs in a Linux network namespace with no direct internet egress; all
machine-to-machine (M2M) traffic is funnelled through a local proxy that attaches per-domain
credentials and logs every request. A server compromise therefore leaks no third-party API keys,
and the operator gets a lightweight audit trail of all outbound traffic for free.

The netns research established the non-negotiable constraint: **attaching a credential to an HTTPS
request requires terminating TLS at the proxy** — you cannot inject a header into a stream you
cannot decrypt. Three models were surfaced:

- **(a) plaintext-to-proxy + TLS origination** — the app speaks plaintext HTTP to the proxy; the
  proxy attaches the credential and opens the *real* TLS connection upstream. No CA. Requires the
  app to be willing to emit plaintext (mild cooperation).
- **(b) MITM with a namespace-scoped CA** — the proxy forges per-host certificates trusted inside
  the namespace. Fully transparent for any `https://` client, but the private CA is a blast-radius
  liability, certificate pinning defeats it, and the proxy inherits responsibility for validating
  upstream certificates.
- **(c) metadata broker / eBPF** — not transparent, or too fragile across library versions.

A fact specific to Exhibit reshapes the usual trade-off: the deployed apps are the operator's
**own first-party code** on their **own single VPS**. "The app cooperates a little" is cheap here
in a way it would not be for a general-purpose proxy fronting arbitrary third-party binaries.

## Decision

**Build the proxy on model (a): plaintext-to-proxy with TLS origination, wired via a forward-proxy
environment variable.**

1. **Transport.** Exhibit injects `HTTP_PROXY` (and `HTTPS_PROXY`) into each app's environment,
   pointing at the app's egress proxy. The app uses its HTTP client's standard proxy support; no
   bespoke SDK.

2. **Credential attachment is `http://`-only.** A request the app makes over `http://` reaches the
   proxy as a readable absolute-URI forward-proxy request. The proxy attaches the credential and
   **originates real TLS** to the upstream on `:443` — plaintext never leaves the host. A request
   the app makes over `https://` arrives as an opaque `CONNECT` tunnel: the proxy tunnels and
   logs it (SNI, destination, byte counts) but **cannot** inject a credential. The operator-facing
   rule is therefore crisp:

   > Call an upstream over `http://` → Exhibit attaches the credential and upgrades to real TLS.
   > Call `https://` directly → you own the auth; Exhibit still logs and gates it.

3. **The allowlist is the fnox M2M set.** Per-domain M2M credentials live in `fnox.toml` as
   `env = false` entries (the proxy reads them via `fnox get`; they are never injected into the
   app's environment — see the fnox research and [secrets flow split #13](https://github.com/ericbstie/exhibit.ericbs.dev/issues/13)).
   That set of `{upstream-domain → credential}` entries simultaneously **is the allowlist and the
   credential keying** — the app declares nothing extra. The proxy keys the credential by the
   request's target host.

4. **M2M boundary — declared upstreams + never overwrite.** The proxy attaches the app's service
   credential only when **both** hold: (i) the target host is in the declared M2M set, and (ii)
   the request carries no `Authorization` header of its own. A call already bearing a user's
   delegated token (browser-auth on behalf of an end user) passes through untouched. Combined with
   topology — the egress proxy is **outbound-only**, and inbound browser authentication reaches
   the app via the ingress on a separate path (see [TLS ingress #9](https://github.com/ericbstie/exhibit.ericbs.dev/issues/9)) —
   the "M2M, never browser auth" boundary is enforced two independent ways.

5. **Logging.** Because credentialed (`http://`) flows are terminated at the proxy, each emits a
   structured metadata record: `{ts, app/domain, dst_host, method, path, status, bytes}`. Opaque
   (`https://` CONNECT) flows log the thinner `{ts, app/domain, dst_host (SNI), bytes, duration}`.
   **Never logged:** request/response bodies, and never the injected credential. Where these
   records are stored and how `ex logs` surfaces them is deferred to the log data-model work.

6. **Enforcement floor.** `HTTP_PROXY` is the cooperative fast path. The guarantee that *nothing*
   escapes uncontrolled comes from the netns withholding direct egress (**fail-closed**): a
   connection that bypasses the proxy has nowhere to route and is dropped (DNS excepted). The exact
   netns/iptables wiring (REDIRECT vs TPROXY as a catch-all, DNS handling) is a composition concern,
   deferred to [per-app runtime composition #11](https://github.com/ericbstie/exhibit.ericbs.dev/issues/11).

Model (b) is **explicitly not adopted**, even as a fallback, to keep the core engine single-pathed:
no private CA to manage, rotate, or leak; no cert-pinning breakage; no proxy-side upstream cert
validation burden. Opaque third-party binaries that hardcode `https://` and refuse proxy env simply
do not get credential attachment — they fail closed and must be adapted, which is acceptable for a
first-party, single-operator tool.

## Consequences

**Positive**

- Apps never hold outbound secrets; a server compromise leaks no third-party keys. The core property holds.
- No CA infrastructure, no forged certificates, nothing for certificate pinning to break.
- Free, per-request outbound audit log for the credentialed path.
- The proxy is single-pathed and cheap to build and to prove.

**Negative / accepted costs**

- Apps must cooperate: honor `HTTP_PROXY` and use `http://` for credential-attached M2M calls. This
  is a documented convention, not magic.
- SDKs that hardcode `https://` or ignore proxy env get no credential injection (they fail closed).
  Mitigation is per-app: point the SDK at an `http://` base URL, or configure its proxy support.
- `https://` CONNECT tunnels yield thin logs (no method/path/status). Full-fidelity logging requires
  routing the call over `http://`.

**Follows on**

- [Prove: transparent netns credential proxy #12](https://github.com/ericbstie/exhibit.ericbs.dev/issues/12) —
  the PoC now targets model (a) specifically: `HTTP_PROXY` app → proxy injects on `http://` →
  TLS-originates upstream; verify `https://` tunnels-and-logs; verify netns fail-closed on direct egress.
- [Decide: secrets flow split #13](https://github.com/ericbstie/exhibit.ericbs.dev/issues/13) — now unblocked;
  formalizes the `env = false` M2M vs `env = true` app-runtime split this ADR leans on.
- [Decide: per-app runtime composition #11](https://github.com/ericbstie/exhibit.ericbs.dev/issues/11) — owns the
  netns/iptables enforcement-floor wiring referenced here (still also blocked by ingress #9).
