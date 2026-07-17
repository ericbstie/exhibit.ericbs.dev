---
status: accepted
---

# Control plane: SSH, not a networked API

Resolves [#7](https://github.com/ericbstie/exhibit.ericbs.dev/issues/7).

`ex <cmd>` shells out to the system `ssh` and execs `exhibit-server <cmd>` on the VPS: the deploy archive streams over stdin, NDJSON step-events stream back over stdout (a live deploy progress feed for free), and buffered `prepare` output arrives on stderr on failure. `ls`/`logs`/`audit` are subcommands; `logs --follow` is a live tail.

Auth is the operator's own SSH key; server identity is `known_hosts` TOFU. There is no public HTTP control API, no control-plane TLS, and no device-code/browser flow — `ex login` just records the SSH target and remote exhibit root in `~/.config/exhibit/config.toml` and runs a version handshake. `exhibit-server` is unprivileged; all privileged work happens in `exhibitd` behind a local Unix socket (ADR 0002), so the SSH entry point never escalates — it hands a message to the one reviewed root process.
