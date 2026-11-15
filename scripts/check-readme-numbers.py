#!/usr/bin/env python3
"""README eval numbers must match docs/evidence/evals.md (M4-03).

The results file's "## Summary" section is a list of `- label: value` lines written by the eval runner.
Every place the README states one of those labels followed by a number (`label: 100%`, `label of 76`,
`label is 95%`) must state the file's value. Exit 0 when they all match, 1 on any difference (each one
printed), 2 on a usage or input error.

    python3 scripts/check-readme-numbers.py [--readme README.md] [--evidence docs/evidence/evals.md]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NUMBER = r"(?:USD\s*)?(\d[\d,]*(?:\.\d+)?%?)"


def summary(evidence: str) -> dict[str, str]:
    """`- label: value` lines of the Summary section, label lower-cased, value's leading number."""
    m = re.search(r"^## Summary\s*$(.*?)^## ", evidence, re.S | re.M)
    if not m:
        raise ValueError("no '## Summary' section in the results file")
    out: dict[str, str] = {}
    for line in m.group(1).splitlines():
        lm = re.match(r"^- ([a-z][a-z \-]*?): " + NUMBER, line.strip())
        if lm:
            out[lm.group(1).strip().lower()] = lm.group(2)
    if not out:
        raise ValueError("the Summary section has no numeric lines")
    return out


def norm(v: str) -> str:
    v = v.replace(",", "")
    pct = v.endswith("%")
    num = float(v.rstrip("%"))
    return f"{num:g}{'%' if pct else ''}"


def check(readme: str, numbers: dict[str, str]) -> list[str]:
    errors: list[str] = []
    taken: list[tuple[int, int]] = []
    for label in sorted(numbers, key=len, reverse=True):
        pattern = re.compile(
            r"(?<![\w-])" + re.escape(label) + r"\s*(?::|=|of|is|was|at)?\s*" + NUMBER, re.I
        )
        for m in pattern.finditer(readme):
            if any(s <= m.start() < e for s, e in taken):
                continue  # part of a longer label already checked ("adversarial cases" vs "cases")
            taken.append((m.start(), m.end()))
            if norm(m.group(1)) != norm(numbers[label]):
                line = readme.count("\n", 0, m.start()) + 1
                errors.append(
                    f"README.md:{line}: '{m.group(0)}' but docs/evidence/evals.md says {label}: {numbers[label]}"
                )
    return errors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--readme", default=str(ROOT / "README.md"))
    ap.add_argument("--evidence", default=str(ROOT / "docs/evidence/evals.md"))
    args = ap.parse_args()
    try:
        numbers = summary(Path(args.evidence).read_text(encoding="utf-8"))
        readme = Path(args.readme).read_text(encoding="utf-8")
    except (OSError, ValueError) as e:
        print(f"check-readme-numbers: {e}", file=sys.stderr)
        return 2
    errors = check(readme, numbers)
    for e in errors:
        print(e, file=sys.stderr)
    if errors:
        return 1
    print(f"check-readme-numbers: README matches {len(numbers)} numbers of {args.evidence}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
