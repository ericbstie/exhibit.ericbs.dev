# Local mirror of the CI regression checks (see .github/workflows/ci.yml).
# Run `make check` before pushing to catch what CI would catch.

.PHONY: check lint links adr spell help

help:
	@echo "Targets:"
	@echo "  make check   Run every regression check (lint + links + adr + spell)"
	@echo "  make lint    Markdown lint (markdownlint-cli2 via npx)"
	@echo "  make links   Internal links, anchors, and path references"
	@echo "  make adr     ADR numbering, headings, and index sync"
	@echo "  make spell   Spell check with codespell"

check: lint links adr spell
	@echo "All regression checks passed."

lint:
	npx --yes markdownlint-cli2

links:
	python3 .github/scripts/check_links.py

adr:
	python3 .github/scripts/check_adrs.py

spell:
	codespell README.md CLAUDE.md docs .github
