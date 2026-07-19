# CI regression checks

This repo is a design record — Architecture Decision Records and agent-skill
docs, no application code yet. The CI in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
guards against the regressions that actually happen to documentation: broken
cross-references, an ADR index that drifts out of sync, malformed Markdown,
and typos.

Every check runs on pushes to `main`, on pull requests, weekly (to catch
external link rot), and on demand (`workflow_dispatch`). Each is a separate
job so a red X points straight at what broke.

Every tool is installed and run through [mise](https://mise.jdx.dev): the
tools and check commands live in [`mise.toml`](../mise.toml) as tasks, so CI
and local runs use the exact same definitions. Tools are declared per-task,
so the pure-Python checks pull in nothing. The Markdown linter is fetched and
run with [aube](https://aube.jdx.dev) (a Node package manager) via `aube dlx`
rather than npm, and only the external-link check installs `lychee`.

## The checks

| Job | What it enforces | Task |
|-----|------------------|------|
| **Markdown lint** | Structural Markdown rules — list spacing, fenced-code languages, heading nesting, stray whitespace. Prose-style rules (line length, emphasis-as-heading) are off on purpose. | `mise run lint` — `markdownlint-cli2` (fetched via `aube dlx`) with `.markdownlint-cli2.jsonc` |
| **Internal links & references** | Relative `[text](path)` links resolve, `#anchor`s point at real headings, and inline-code paths under `docs/`, `.github/`, `.claude/` exist. | `mise run links` — [`check_links.py`](../.github/scripts/check_links.py) |
| **ADR consistency** | ADR files are named `NNNN-slug.md`, numbered uniquely and contiguously from 0001, each has a heading, and [`docs/adr/README.md`](adr/README.md) lists every one exactly once. | `mise run adr` — [`check_adrs.py`](../.github/scripts/check_adrs.py) |
| **Spelling** | Common typos in prose. Domain jargon is safe; codespell only flags known misspellings. | `mise run spell` — `codespell` via `.codespellrc` |
| **External links** | `http(s)` links (GitHub issues, ADRs, referenced tools) still resolve. | `mise run external-links` — `lychee` via `lychee.toml` |

Scope is this project's own docs (`README.md`, `CLAUDE.md`, `docs/`,
`.github/`). The vendored engineering skills under `.claude/skills/` are
third-party (see `.claude/skills/LICENSE-mattpocock-skills`) and are not
linted or spell-checked, though first-party docs may still reference paths
inside them.

## Running locally

Install [mise](https://mise.jdx.dev), then:

```sh
mise run check            # every offline check (lint + links + adr + spell)
mise run lint             # markdownlint-cli2
mise run links            # internal link & reference check
mise run adr              # ADR numbering + index sync
mise run spell            # codespell
mise run external-links   # lychee (needs network)
```

mise installs each task's tools on first run — no manual `npm`/`pip` setup.
`check` deliberately omits the external-link check so it stays fully offline.

## Extending

- **A false-positive typo?** Add the lowercase word to `ignore-words-list`
  in `.codespellrc`.
- **A flaky or intentionally-unreachable URL?** Add a regex to
  `.lycheeignore`.
- **A Markdown rule fighting the writing style?** Adjust the `config` block
  in `.markdownlint-cli2.jsonc`, with a comment explaining why.
