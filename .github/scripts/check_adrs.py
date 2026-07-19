#!/usr/bin/env python3
"""Validate the Architecture Decision Record set and its index.

ADRs are the core design record for this project (see `docs/adr/README.md`),
so drift between the files and the index table is a real regression: a new
ADR that never got listed, an index row pointing at a renamed file, a
duplicated or skipped number. This check enforces the invariants that keep
the set navigable:

  1. Every ADR file is named `NNNN-kebab-slug.md` (four-digit number).
  2. ADR numbers are unique and contiguous starting at 0001 (no gaps).
  3. Every ADR file has a non-empty top-level `#` heading.
  4. The index table in `docs/adr/README.md` lists every ADR exactly once,
     and every link in it points at a file that exists.

Exit status is non-zero if any invariant is violated.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ADR_DIR = REPO_ROOT / "docs" / "adr"
INDEX = ADR_DIR / "README.md"

FILENAME_RE = re.compile(r"^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$")
# Links in the index that point at an ADR file: [label](NNNN-slug.md)
INDEX_LINK_RE = re.compile(r"\]\((\d{4}-[a-z0-9-]+\.md)(?:#[^)]*)?\)")
H1_RE = re.compile(r"^#\s+(\S.*?)\s*$", re.MULTILINE)


def first_h1(text: str) -> str | None:
    # Skip an optional YAML front-matter block before the heading.
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            text = text[end + 4:]
    m = H1_RE.search(text)
    return m.group(1) if m else None


def adr_files_in(adr_dir: Path) -> list[Path]:
    if not adr_dir.is_dir():
        return []
    return sorted(p for p in adr_dir.glob("*.md") if p.name.lower() != "readme.md")


def check(repo_root: Path = REPO_ROOT) -> list[str]:
    errors: list[str] = []
    adr_dir = repo_root / "docs" / "adr"
    index = adr_dir / "README.md"

    if not adr_dir.is_dir():
        return [f"ADR directory not found: {adr_dir.relative_to(repo_root)}"]

    adr_files = adr_files_in(adr_dir)
    if not adr_files:
        return ["no ADR files found under docs/adr/"]

    numbers: dict[int, Path] = {}
    for path in adr_files:
        name = path.name
        m = FILENAME_RE.match(name)
        if not m:
            errors.append(
                f"{path.relative_to(repo_root)}: filename must match "
                f"NNNN-kebab-slug.md"
            )
            continue
        num = int(m.group(1))
        if num in numbers:
            errors.append(
                f"duplicate ADR number {num:04d}: {numbers[num].name} and {name}"
            )
        else:
            numbers[num] = path

        if not first_h1(path.read_text(encoding="utf-8")):
            errors.append(
                f"{path.relative_to(repo_root)}: missing a top-level '# ' heading"
            )

    # Contiguous numbering from 0001.
    if numbers:
        expected = set(range(1, max(numbers) + 1))
        missing = sorted(expected - set(numbers))
        if missing:
            errors.append(
                "ADR numbering has gaps; missing: "
                + ", ".join(f"{n:04d}" for n in missing)
            )

    # Index-table sync.
    if not index.is_file():
        errors.append("docs/adr/README.md (ADR index) is missing")
    else:
        index_text = index.read_text(encoding="utf-8")
        linked = INDEX_LINK_RE.findall(index_text)
        linked_names = set(linked)

        for name in linked:
            if linked.count(name) > 1:
                errors.append(f"ADR index links {name} more than once")
            if not (adr_dir / name).is_file():
                errors.append(f"ADR index links a missing file: {name}")

        file_names = {p.name for p in adr_files}
        for name in sorted(file_names - linked_names):
            errors.append(f"ADR {name} exists but is not listed in the index")

    return errors


def main() -> int:
    errors = check()
    n = len(adr_files_in(ADR_DIR))
    print(f"checked {n} ADR file(s) against docs/adr/README.md")
    if errors:
        print(f"\nFAIL: {len(errors)} ADR problem(s):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print("OK: ADR numbering, headings, and index are consistent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
