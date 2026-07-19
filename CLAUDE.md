# CLAUDE.md

## Agent skills

### Issue tracker

Issues and PRDs live in this repo's GitHub Issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The default five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Minimal-code discipline (ponytail)

Four skills from the [ponytail](https://github.com/DietrichGebert/ponytail) harness (MIT, `.claude/skills/LICENSE-ponytail`) enforce "the best code is the code never written" — the corrective for this repo's tendency to over-build its security surface. Prefer reuse → stdlib → native platform feature → existing dependency before writing new code.

- **ponytail** (`/ponytail [lite|full|ultra]`) — lazy-senior-dev mode on any coding task; runs the YAGNI ladder *after* understanding the problem, never instead of it. Validation, error handling, and security are never simplified away.
- **ponytail-review** (`/ponytail-review`) — reviews the current diff for over-engineering only, returns a `delete`/`stdlib`/`native`/`yagni`/`shrink` list. Complements `/code-review` (correctness + spec).
- **ponytail-audit** (`/ponytail-audit`) — same lens, whole-repo, ranked biggest cut first.
- **ponytail-debt** (`/ponytail-debt`) — harvests `ponytail:` shortcut comments into a ledger so deliberate deferrals don't rot.

**Convention:** mark a deliberate corner-cut with `ponytail: <ceiling>, <upgrade trigger>` (e.g. `# ponytail: single age key, split per-app if blast radius matters`) — that's what `ponytail-debt` tracks.

Not installed: `ponytail-gain` (fixed promo scoreboard) and `ponytail-help` (indexes the others) — neither does repo work, so per ponytail's own ladder they were skipped.
