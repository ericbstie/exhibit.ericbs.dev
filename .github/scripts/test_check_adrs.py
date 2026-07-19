"""Tests for the ADR consistency check (check_adrs.py)."""

from __future__ import annotations

from pathlib import Path

import check_adrs


def build_repo(tmp_path: Path, adrs: dict[str, str], index: str | None) -> Path:
    """Create a fake repo with the given ADR files and an optional index."""
    adr_dir = tmp_path / "docs" / "adr"
    adr_dir.mkdir(parents=True)
    for name, body in adrs.items():
        (adr_dir / name).write_text(body, encoding="utf-8")
    if index is not None:
        (adr_dir / "README.md").write_text(index, encoding="utf-8")
    return tmp_path


def index_for(*names: str) -> str:
    rows = "\n".join(f"| [{n[:4]}]({n}) | decision |" for n in names)
    return "# ADRs\n\n| ADR | Decision |\n|-----|----------|\n" + rows + "\n"


# --- happy path ------------------------------------------------------------

def test_valid_set_has_no_errors(tmp_path):
    adrs = {
        "0001-first.md": "# 1. First",
        "0002-second.md": "# 2. Second",
    }
    repo = build_repo(tmp_path, adrs, index_for("0001-first.md", "0002-second.md"))
    assert check_adrs.check(repo) == []


def test_front_matter_before_heading_is_ok(tmp_path):
    adrs = {"0001-fm.md": "---\nstatus: accepted\n---\n\n# 1. Has front matter\n"}
    repo = build_repo(tmp_path, adrs, index_for("0001-fm.md"))
    assert check_adrs.check(repo) == []


# --- individual invariants -------------------------------------------------

def test_gap_in_numbering_is_flagged(tmp_path):
    adrs = {"0001-a.md": "# 1. A", "0003-c.md": "# 3. C"}
    repo = build_repo(tmp_path, adrs, index_for("0001-a.md", "0003-c.md"))
    errors = check_adrs.check(repo)
    assert any("gap" in e and "0002" in e for e in errors)


def test_duplicate_number_is_flagged(tmp_path):
    # Same number, two different slugs.
    adrs = {"0001-a.md": "# 1. A", "0001-b.md": "# 1. B"}
    repo = build_repo(tmp_path, adrs, index_for("0001-a.md", "0001-b.md"))
    errors = check_adrs.check(repo)
    assert any("duplicate ADR number" in e for e in errors)


def test_bad_filename_is_flagged(tmp_path):
    adrs = {"0001-ok.md": "# 1. Ok", "1-bad.md": "# bad"}
    repo = build_repo(tmp_path, adrs, index_for("0001-ok.md"))
    errors = check_adrs.check(repo)
    assert any("NNNN-kebab-slug.md" in e for e in errors)


def test_missing_heading_is_flagged(tmp_path):
    adrs = {"0001-empty.md": "no heading here, just text\n"}
    repo = build_repo(tmp_path, adrs, index_for("0001-empty.md"))
    errors = check_adrs.check(repo)
    assert any("top-level" in e for e in errors)


def test_unlisted_adr_is_flagged(tmp_path):
    adrs = {"0001-a.md": "# 1. A", "0002-b.md": "# 2. B"}
    # Index omits 0002.
    repo = build_repo(tmp_path, adrs, index_for("0001-a.md"))
    errors = check_adrs.check(repo)
    assert any("0002-b.md" in e and "not listed" in e for e in errors)


def test_index_links_missing_file_is_flagged(tmp_path):
    adrs = {"0001-a.md": "# 1. A"}
    # Index references a file that doesn't exist.
    repo = build_repo(tmp_path, adrs, index_for("0001-a.md", "0002-ghost.md"))
    errors = check_adrs.check(repo)
    assert any("0002-ghost.md" in e and "missing file" in e for e in errors)


def test_missing_index_is_flagged(tmp_path):
    adrs = {"0001-a.md": "# 1. A"}
    repo = build_repo(tmp_path, adrs, index=None)
    errors = check_adrs.check(repo)
    assert any("index" in e for e in errors)


def test_missing_adr_dir_is_flagged(tmp_path):
    errors = check_adrs.check(tmp_path)
    assert any("ADR directory not found" in e for e in errors)


# --- pure helpers ----------------------------------------------------------

def test_first_h1_skips_front_matter():
    assert check_adrs.first_h1("---\nk: v\n---\n\n# Title\n") == "Title"


def test_first_h1_none_when_absent():
    assert check_adrs.first_h1("just a paragraph\n") is None
