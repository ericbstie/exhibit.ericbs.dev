# Architecture Decision Records

The core-engine design, one decision per file. These were charted via the wayfinder map ([#2](https://github.com/ericbstie/exhibit.ericbs.dev/issues/2)) and validated before implementation ([#18](https://github.com/ericbstie/exhibit.ericbs.dev/issues/18)); ADRs 0003–0008 land the decisions whose original `spec/*` branches were lost, plus the revisions the validation produced.

| ADR | Decision | Source ticket |
|-----|----------|---------------|
| [0001](0001-transparent-credential-proxy-model.md) | Transparent credential proxy — model (a), plaintext-in / TLS-out. **Transport superseded by 0008.** | [#8](https://github.com/ericbstie/exhibit.ericbs.dev/issues/8) |
| [0002](0002-per-app-runtime-composition.md) | Per-app runtime composition — one `exhibit-app@` template in a persistent netns. **Amended per #18.** | [#11](https://github.com/ericbstie/exhibit.ericbs.dev/issues/11) |
| [0003](0003-ingress-tls-host-routing.md) | Ingress — Caddy, explicit per-domain certs, veth-IP routing. **Revises #9** (drops on-demand TLS). | [#9](https://github.com/ericbstie/exhibit.ericbs.dev/issues/9) |
| [0004](0004-secrets-model.md) | Secrets — one exhibitd-held age key, decrypt-outside, two fnox profiles. | [#13](https://github.com/ericbstie/exhibit.ericbs.dev/issues/13) |
| [0005](0005-releases-state-logs.md) | Releases, state, logs — filesystem is the source of truth. **Cutover amended per #28.** | [#6](https://github.com/ericbstie/exhibit.ericbs.dev/issues/6) / [#14](https://github.com/ericbstie/exhibit.ericbs.dev/issues/14) / [#15](https://github.com/ericbstie/exhibit.ericbs.dev/issues/15) / [#16](https://github.com/ericbstie/exhibit.ericbs.dev/issues/16) |
| [0006](0006-ssh-control-plane.md) | Control plane — SSH, not a networked API. | [#7](https://github.com/ericbstie/exhibit.ericbs.dev/issues/7) |
| [0007](0007-delivery-bootstrap.md) | Delivery & bootstrap — mise install channel, `ex init-server`. | [#17](https://github.com/ericbstie/exhibit.ericbs.dev/issues/17) |
| [0008](0008-transparent-interception-transport.md) | **Transport revision** — transparent netns interception replaces proxy env vars. | [#18](https://github.com/ericbstie/exhibit.ericbs.dev/issues/18) |
