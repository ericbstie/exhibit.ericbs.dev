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

## App contract

A deployed app is handed two environment variables:

- `PORT` — where to listen (`127.0.0.1:$PORT`).
- `STATE_DIR` — the only writable location that survives redeploys. Each
  deploy runs from a fresh immutable release directory; anything written
  outside `STATE_DIR` is orphaned by the next deploy.

If the project has a `mise.toml`, its `prepare` task runs on the server
before the release goes live, and `production` is the default run command.

## What's different compared to vercel, coolify etc.?

It's:

- open source & forever free
- slimmed down to hobbyist use needs
- extremely easy to setup and self host
- container-free: apps run as sandboxed processes, so it works on any VPS
- built to proxy secrets & audit outgoing authorised requests
- focused on security & observability out-of-the-box (see `docs/adr/`)
