"""Tests for the internal link & reference check (check_links.py)."""

from __future__ import annotations

from pathlib import Path

import check_links


def write(repo: Path, rel: str, body: str) -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


# --- happy path ------------------------------------------------------------

def test_valid_relative_link_passes(tmp_path):
    write(tmp_path, "docs/adr/0001-a.md", "# A\n\nSee [B](0002-b.md).\n")
    write(tmp_path, "docs/adr/0002-b.md", "# B\n")
    assert check_links.check(tmp_path) == []


def test_valid_inline_path_reference_passes(tmp_path):
    write(tmp_path, "docs/agents/thing.md", "# Thing\n")
    write(tmp_path, "CLAUDE.md", "See `docs/agents/thing.md` for details.\n")
    assert check_links.check(tmp_path) == []


def test_valid_anchor_passes(tmp_path):
    write(tmp_path, "docs/a.md", "# A\n\nJump to [there](#the-section).\n\n## The Section\n")
    assert check_links.check(tmp_path) == []


# --- failure cases ---------------------------------------------------------

def test_broken_relative_link_is_flagged(tmp_path):
    write(tmp_path, "docs/a.md", "# A\n\n[gone](missing.md)\n")
    errors = check_links.check(tmp_path)
    assert any("missing.md" in e and "does not exist" in e for e in errors)


def test_broken_inline_path_is_flagged(tmp_path):
    write(tmp_path, "CLAUDE.md", "See `docs/agents/nope.md`.\n")
    errors = check_links.check(tmp_path)
    assert any("docs/agents/nope.md" in e for e in errors)


def test_bad_anchor_is_flagged(tmp_path):
    write(tmp_path, "docs/a.md", "# A\n\n[x](#no-such-heading)\n\n## Real\n")
    errors = check_links.check(tmp_path)
    assert any("no-such-heading" in e for e in errors)


def test_directory_reference_expecting_dir_is_flagged(tmp_path):
    # `docs/thing/` is written as a directory but resolves to a file.
    write(tmp_path, "docs/thing", "i am a file, not a dir\n")
    write(tmp_path, "CLAUDE.md", "See `docs/thing/`.\n")
    errors = check_links.check(tmp_path)
    assert any("directory" in e for e in errors)


# --- things that must NOT be flagged (regression guards) -------------------

def test_link_inside_inline_code_is_ignored(tmp_path):
    # A `[text](path)` written inside backticks is literal, not a link.
    write(tmp_path, "docs/a.md", "# A\n\nUse `[text](path)` in the table.\n")
    assert check_links.check(tmp_path) == []


def test_link_inside_fenced_code_is_ignored(tmp_path):
    write(tmp_path, "docs/a.md", "# A\n\n```\n[dead](does-not-exist.md)\n```\n")
    assert check_links.check(tmp_path) == []


def test_external_links_are_skipped(tmp_path):
    write(tmp_path, "docs/a.md", "# A\n\n[site](https://example.com/missing)\n")
    assert check_links.check(tmp_path) == []


def test_placeholder_inline_paths_are_ignored(tmp_path):
    # Angle-bracket variables / globs are illustrative, not concrete paths.
    write(tmp_path, "docs/a.md", "# A\n\nLook in `docs/<context>/adr/`.\n")
    assert check_links.check(tmp_path) == []


# --- pure helpers ----------------------------------------------------------

def test_heading_slugs_github_style():
    slugs = check_links.heading_slugs("# Hello World\n## `code` and Punctuation!\n")
    assert "hello-world" in slugs
    assert "code-and-punctuation" in slugs


def test_strip_code_fences_blanks_fenced_content():
    stripped = check_links.strip_code_fences("a\n```\nsecret\n```\nb")
    assert "secret" not in stripped
    assert "a" in stripped and "b" in stripped
