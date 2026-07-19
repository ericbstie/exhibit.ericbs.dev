# CI regression checks

This repo is a design record — Architecture Decision Records and agent-skill
docs, no application code yet. The CI in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
guards against the regressions that actually happen to documentation: broken
cross-references, an ADR index that drifts out of sync, malformed Markdown,
and typos.

Every check runs on pushes to `main`, on pull requests, weekly (to catch
external link rot), and on demand (`workflow_dispatch`). Each is a separate
job so a red X points straight at what broke.

## The checks

| Job | What it enforces | How it runs |
|-----|------------------|-------------|
| **Markdown lint** | Structural Markdown rules — list spacing, fenced-code languages, heading nesting, stray whitespace. Prose-style rules (line length, emphasis-as-heading) are off on purpose. | `markdownlint-cli2` via `.markdownlint-cli2.jsonc` |
| **Internal links & references** | Relative `[text](path)` links resolve, `#anchor`s point at real headings, and inline-code paths under `docs/`, `.github/`, `.claude/` exist. | [`check_links.py`](../.github/scripts/check_links.py) |
| **ADR consistency** | ADR files are named `NNNN-slug.md`, numbered uniquely and contiguously from 0001, each has a heading, and [`docs/adr/README.md`](adr/README.md) lists every one exactly once. | [`check_adrs.py`](../.github/scripts/check_adrs.py) |
| **Spelling** | Common typos in prose. Domain jargon is safe; codespell only flags known misspellings. | `codespell` via `.codespellrc` |
| **External links** | `http(s)` links (GitHub issues, ADRs, referenced tools) still resolve. | `lychee` via `lychee.toml` |

Scope is this project's own docs (`README.md`, `CLAUDE.md`, `docs/`,
`.github/`). The vendored engineering skills under `.claude/skills/` are
third-party (see `.claude/skills/LICENSE-mattpocock-skills`) and are not
linted or spell-checked, though first-party docs may still reference paths
inside them.

## Running locally

```sh
make check      # everything below
make lint       # markdownlint-cli2
make links      # internal link & reference check
make adr        # ADR numbering + index sync
make spell      # codespell
```

`make lint` needs Node (for `npx`); `make spell` needs `codespell`
(`pip install codespell`); the rest are pure Python 3 with no dependencies.

## Extending

- **A false-positive typo?** Add the lowercase word to `ignore-words-list`
  in `.codespellrc`.
- **A flaky or intentionally-unreachable URL?** Add a regex to
  `.lycheeignore`.
- **A Markdown rule fighting the writing style?** Adjust the `config` block
  in `.markdownlint-cli2.jsonc`, with a comment explaining why.
