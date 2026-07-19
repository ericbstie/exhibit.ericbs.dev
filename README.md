# exhibit.ericbs.dev

Publish webapps instantly with ease. Intended for use on a single VPS.

1. Enter a webapp project (html/react/vue/svelte)
2. `ex deploy --domain project.ericbs.dev -- mise run production`
3. `curl https://project.ericbs.dev` - 200 OK

Exhibit comes with a dashboard to:

- view health & terminal logs
- proxy requests & attach auth from outside the webapp sandboxes
- monitor traffic & audit every outbound request
- see which sandbox protections are active per app

## Setup

Exhibit is a [Bun](https://bun.sh) project (Bun >= 1.2) — this is developing
Exhibit itself, not deploying an app with it (see the quickstart above for
that).

```sh
git clone https://github.com/ericbstie/exhibit.ericbs.dev.git
cd exhibit.ericbs.dev
bun install
```

Runnable commands:

- `bun run typecheck` — `tsc --noEmit` over `src/` and `tests/`
- `bun test` — unit tests
- `bun src/ex/main.ts` — run the `ex` laptop CLI from source
- `bun src/server/main.ts` — run `exhibit-server` from source

The e2e suite (`tests/e2e/`) needs a Linux host with systemd, Caddy (admin API
on `127.0.0.1:2019`), mise, and a loopback sshd forcing `exhibit-server` as
the SSH command — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
for the full setup. With that in place:

```sh
EXHIBIT_E2E=1 EXHIBIT_SSH_E2E=1 bun test
```

The docs (`README.md`, `CLAUDE.md`, `docs/`, `.github/`) have their own
offline regression checks, run through [mise](https://mise.jdx.dev) — see
[`docs/ci.md`](docs/ci.md):

```sh
mise run check   # lint + links + adr + spell + test
```

## What's different compared to vercel, coolify etc.?

It's:

- open source & forever free
- slimmed down to hobbyist use needs
- extremely easy to setup and self host
- container-free: apps run as sandboxed processes, so it works on any VPS
- built to proxy secrets & audit outgoing authorised requests
- focused on security & observability out-of-the-box (see `docs/adr/`)

## App contract

A deployed app is handed two environment variables:

- `PORT` — where to listen (`127.0.0.1:$PORT`).
- `STATE_DIR` — the only writable location that survives redeploys. Each
  deploy runs from a fresh immutable release directory; anything written
  outside `STATE_DIR` is orphaned by the next deploy.

If the project has a `mise.toml`, its `prepare` task runs on the server
before the release goes live, and `production` is the default run command.
