# exhibit.ericbs.dev

Publish webapps instantly with ease. Intended for use on a single VPS.

1. Enter a webapp project (html/react/vue/svelte)
2. `ex deploy --domain project.ericbs.dev --enable-network-monitoring -- mise run production`
3. `curl https://project.ericbs.dev` - 200 OK

Exhibit comes with a dashboard to:
- view health & terminal logs
- proxy requests & attach auth from outside the webapp sandboxes
- monitor traffic

## What's different compared to vercel, coolify etc.?

It's:
- open source & forever free
- slimmed down to hobbyist use needs
- extremely easy to setup and self host
- built to proxy secrets & audits outgoing authorised requests
- focused on security & observability out-of-the-box (see security)

## DNS adaptors

Exhibit uses a single interface for DNS management. 
DNS adaptors map DNS-provider specific APIs to Exhibit's interface.

## Rationale & decisions

#### Security

#### Why proxy requests through exhibit?

By default exhibit will *not* proxy requests. Use the `--enable-network-monitoring` flag when deploying with `ex deploy` to enable it.

Proxying requests allows exhibit to monitor traffic, whitelist/blacklist networks and disallow requests dynamically through exhibit.
It can also be used to, for example:
- Allow only GET requests to `*.super-sensitive-environment.company.com`
- Attach `Bearer ...` token on all requests to `api.company.com`. This separates credentials from potentially weak/unsecured/untrusted webapps.
