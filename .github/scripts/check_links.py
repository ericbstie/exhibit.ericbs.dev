#!/usr/bin/env python3
"""Validate internal links and file references in the project's own docs.

This catches the most common documentation regression: a link or a
referenced path that no longer resolves because a file was renamed, moved,
or deleted. It checks three things, all offline (no network):

  1. Relative Markdown links `[text](path)` resolve to an existing file or
     directory, and any `#anchor` resolves to a real heading.
  2. Same-file anchor links `[text](#anchor)` resolve to a heading in the
     same document.
  3. Inline-code path references like `docs/agents/domain.md` that point at
     concrete repo directories (docs/, .github/, .claude/) exist on disk.

External links (http/https/mailto) are out of scope here; they are covered
separately by the link-checker workflow.

Scope: the project's first-party documentation only. The vendored skills
under `.claude/skills/` are third-party and are not scanned as sources
(though first-party docs *may* legitimately reference paths inside them).

Exit status is non-zero if any problem is found.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# First-party documentation that this repo authors and maintains.
SOURCE_GLOBS = ["README.md", "CLAUDE.md", "docs/**/*.md", ".github/**/*.md"]

# Directories that hold real, tracked repo paths. Inline-code tokens that
# start with one of these are treated as concrete references that must
# resolve. Anything else in backticks (illustrative names like
# `CONTEXT.md`, `fnox.toml`, `src/<context>/…`) is left alone.
CONCRETE_PREFIXES = ("docs/", ".github/", ".claude/")

EXTERNAL_SCHEME = re.compile(r"^(?:https?|mailto|tel|ftp):", re.IGNORECASE)

# [text](target) and ![alt](target), tolerating an optional "title".
LINK_RE = re.compile(r"!?\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+[\"'][^\"']*[\"'])?\s*\)")

# `inline code` spans (single backtick; good enough for path references).
INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")

FENCE_RE = re.compile(r"^\s*(```|~~~)")


def strip_code_fences(text: str) -> str:
    """Blank out fenced code blocks so code samples aren't parsed as links."""
    out, in_fence = [], False
    for line in text.splitlines():
        if FENCE_RE.match(line):
            in_fence = not in_fence
            out.append("")
            continue
        out.append("" if in_fence else line)
    return "\n".join(out)


def heading_slugs(text: str) -> set[str]:
    """GitHub-style anchor slugs for every ATX heading in `text`."""
    slugs: set[str] = set()
    counts: dict[str, int] = {}
    for line in strip_code_fences(text).splitlines():
        m = re.match(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$", line)
        if not m:
            continue
        title = m.group(2)
        # Reduce to visible text: link text, no code ticks, no emphasis.
        title = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", title)
        title = title.replace("`", "")
        title = re.sub(r"[*_]+", "", title)
        slug = title.strip().lower()
        slug = re.sub(r"[^\w\s-]", "", slug)
        slug = re.sub(r"\s+", "-", slug)
        base = slug
        n = counts.get(base, 0)
        if n:
            slug = f"{base}-{n}"
        counts[base] = n + 1
        slugs.add(slug)
    return slugs


def iter_sources(repo_root: Path = REPO_ROOT) -> list[Path]:
    seen: dict[Path, None] = {}
    for pattern in SOURCE_GLOBS:
        for path in sorted(repo_root.glob(pattern)):
            if path.is_file() and ".claude/skills" not in path.as_posix():
                seen[path] = None
    return list(seen)


def check(repo_root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
    slug_cache: dict[Path, set[str]] = {}

    def slugs_for(path: Path) -> set[str]:
        if path not in slug_cache:
            try:
                slug_cache[path] = heading_slugs(path.read_text(encoding="utf-8"))
            except OSError:
                slug_cache[path] = set()
        return slug_cache[path]

    sources = iter_sources(repo_root)
    link_count = ref_count = 0

    for src in sources:
        raw = src.read_text(encoding="utf-8")
        body = strip_code_fences(raw)
        # For link detection, also neutralize inline-code spans: a
        # `[text](path)` written inside backticks is literal, not a link.
        link_body = INLINE_CODE_RE.sub(lambda m: " " * len(m.group(0)), body)
        rel = src.relative_to(repo_root)

        # --- Markdown links -------------------------------------------------
        for target in LINK_RE.findall(link_body):
            if EXTERNAL_SCHEME.match(target):
                continue
            link_count += 1
            path_part, _, anchor = target.partition("#")
            path_part = re.sub(r"%20", " ", path_part).strip()

            if not path_part:  # pure "#anchor" -> same file
                if anchor and anchor.lower() not in slugs_for(src):
                    errors.append(f"{rel}: anchor '#{anchor}' not found in this file")
                continue

            dest = (src.parent / path_part).resolve()
            if not dest.exists():
                errors.append(f"{rel}: link target does not exist -> {target}")
                continue
            if anchor and dest.suffix == ".md":
                if anchor.lower() not in slugs_for(dest):
                    errors.append(
                        f"{rel}: anchor '#{anchor}' not found in {path_part}"
                    )

        # --- Inline-code repo-path references -------------------------------
        for token in INLINE_CODE_RE.findall(body):
            token = token.strip()
            if not token.startswith(CONCRETE_PREFIXES):
                continue
            # A reference may carry trailing prose punctuation.
            cleaned = token.rstrip(".,;:)")
            is_dir = cleaned.endswith("/")
            cleaned = cleaned.rstrip("/")
            # Skip placeholder-y tokens (globs / angle-bracket variables).
            if any(c in cleaned for c in "*<>"):
                continue
            ref_count += 1
            dest = (repo_root / cleaned).resolve()
            if not dest.exists():
                errors.append(f"{rel}: referenced path does not exist -> `{token}`")
            elif is_dir and not dest.is_dir():
                errors.append(f"{rel}: expected a directory -> `{token}`")

    print(
        f"checked {len(sources)} files: "
        f"{link_count} relative links, {ref_count} path references"
    )
    return errors


def main() -> int:
    errors = check()
    if errors:
        print(f"\nFAIL: {len(errors)} broken reference(s):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print("OK: all internal links and path references resolve")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
