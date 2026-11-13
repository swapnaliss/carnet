#!/usr/bin/env python3
"""Fails if a STRIDE row in docs/architecture.md section 8 has no named test in tests/security/README.md.

An entry is `- <file> :: <text>`; the file must exist and contain <text>. Rows and sections are matched
as `<Threat> · <Example>`.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
arch = (ROOT / "docs/architecture.md").read_text(encoding="utf-8")
readme = (ROOT / "tests/security/README.md").read_text(encoding="utf-8")

m = re.search(r"## 8\. Security.*?\n(\|.*?)(?:\n\n|\Z)", arch, re.S)
if not m:
    sys.exit("check-stride-map: STRIDE table not found in docs/architecture.md section 8")
rows = []
for line in m.group(1).splitlines():
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    if len(cells) < 3 or cells[0] in ("Threat",) or set(cells[0]) <= set("-"):
        continue
    rows.append((cells[0], cells[1]))

sections: dict[str, list[tuple[str, str]]] = {}
current = None
for line in readme.splitlines():
    if line.startswith("## "):
        current = line[3:].strip()
        sections[current] = []
    elif current and line.startswith("- ") and " :: " in line:
        f, _, text = line[2:].partition(" :: ")
        sections[current].append((f.strip(), text.strip()))

errors = []
for threat, example in rows:
    key = f"{threat} · {example}"
    entries = sections.get(key)
    if not entries:
        errors.append(f"no test mapped for STRIDE row: {key}")
        continue
    for f, text in entries:
        p = ROOT / f
        if not p.is_file():
            errors.append(f"{key}: file missing: {f}")
        elif text not in p.read_text(encoding="utf-8"):
            errors.append(f"{key}: text not found in {f}: {text!r}")

if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"check-stride-map: {len(rows)} STRIDE rows, all mapped to existing named tests")
