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

Exhibit has two sides: `exhibit-server` running on the VPS, and the `ex` CLI
you run on your laptop to deploy to it. There's no packaged installer yet —
`ex init-server`, a one-command provisioner, is still on the roadmap (see
[ADR 0007](docs/adr/0007-delivery-bootstrap.md)) — so today both run from
source with [Bun](https://bun.sh) (>= 1.2).

**On the VPS:** have systemd, [mise](https://mise.jdx.dev) (apps run `mise
run production`), and [Caddy](https://caddyserver.com) with its admin API
reachable at `127.0.0.1:2019` already set up. Then make `exhibit-server`
the forced command for the SSH key you'll deploy with, e.g. in
`authorized_keys`:

```sh
command="bun /path/to/exhibit.ericbs.dev/src/server/main.ts",restrict ssh-ed25519 AAAA...
```

**On your laptop:**

```sh
git clone https://github.com/ericbstie/exhibit.ericbs.dev.git
cd exhibit.ericbs.dev
bun install
bun src/ex/main.ts login <ssh-target>   # records the server in ~/.config/exhibit/config.toml
```

Then, from inside a webapp project:

```sh
bun /path/to/exhibit.ericbs.dev/src/ex/main.ts deploy --domain project.ericbs.dev -- mise run production
```

Other commands: `ex ls` lists deployed apps and their releases, `ex logs
<domain> [--follow] [-n <lines>]` tails a running app's logs.

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
