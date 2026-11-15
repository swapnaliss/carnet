#!/usr/bin/env python3
"""Decides whether the `live` eval job runs (M4-03), from the EVAL_LIVE_PATHS filter in
.github/workflows/evals.yml, so the filter has one source.

    python3 scripts/eval-ci-trigger.py --base <sha> --head <sha>   the CI job: git diff, writes live=true|false
    python3 scripts/eval-ci-trigger.py --files a b c               dry run on given paths
    python3 scripts/eval-ci-trigger.py --self-test                 dry run on a fixed table, plus the fork rule

Exit 0 on success (whatever the decision), 1 when the self-test fails, 2 on a usage error.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github/workflows/evals.yml"

# (path, whether a change to it must trigger the live run)
SELF_TEST = [
    ("packages/agent/src/drafting/prompts/draft.ts", True),
    ("packages/agent/src/extraction/prompts/invoice.ts", True),
    ("packages/agent/src/criticality/prompts/criticality.ts", True),
    ("packages/domain/src/rfi/verifier.ts", True),
    ("packages/domain/src/evidence/quote-match.ts", True),
    ("packages/agent/src/pricing.ts", True),
    ("packages/agent/src/drafting/draft.ts", True),
    ("packages/agent/evals/rubric.md", True),
    ("README.md", False),
    ("apps/web/src/strings.ts", False),
    ("packages/agent/test/harness.test.ts", False),
    ("packages/agent/evals/suite/run.ts", False),
    ("packages/domain/src/rfi/fingerprint.ts", False),
    ("docs/evidence/evals.md", False),
]


def live_paths(workflow: str) -> list[str]:
    m = re.search(r"^\s*EVAL_LIVE_PATHS:\s*\|\s*\n((?:[ \t]+\S.*\n?)+)", workflow, re.M)
    if not m:
        raise ValueError("EVAL_LIVE_PATHS block not found in the workflow")
    return [ln.strip() for ln in m.group(1).splitlines() if ln.strip()]


def glob_re(glob: str) -> re.Pattern[str]:
    out = ""
    i = 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif glob.startswith("**", i):
            out += ".*"
            i += 2
        elif glob[i] == "*":
            out += "[^/]*"
            i += 1
        else:
            out += re.escape(glob[i])
            i += 1
    return re.compile(f"^{out}$")


def triggers(paths: list[str], files: list[str]) -> list[str]:
    pats = [glob_re(p) for p in paths]
    return [f for f in files if any(p.match(f) for p in pats)]


def fork_rule_problems(workflow: str) -> list[str]:
    problems = []
    if re.search(r"^\s*-?\s*pull_request_target\b", workflow, re.M):
        problems.append("the workflow uses pull_request_target (would hand the secret to fork PRs)")
    live = workflow.split("\n  live:", 1)
    if len(live) != 2:
        return problems + ["no `live` job"]
    before, live_job = live
    if "secrets.ANTHROPIC_API_KEY" in before:
        problems.append("ANTHROPIC_API_KEY is referenced outside the live job")
    if "github.event.pull_request.head.repo.full_name == github.repository" not in live_job:
        problems.append("the live job has no same-repository guard for pull requests")
    if "needs.changes.outputs.live == 'true'" not in live_job:
        problems.append("the live job is not gated on the paths filter")
    if "EVAL_SPEND_CAP_USD" not in live_job:
        problems.append("the live job sets no EVAL_SPEND_CAP_USD")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workflow", default=str(WORKFLOW))
    ap.add_argument("--files", nargs="*")
    ap.add_argument("--base")
    ap.add_argument("--head")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    workflow = Path(args.workflow).read_text(encoding="utf-8")
    paths = live_paths(workflow)

    if args.self_test:
        bad = []
        for f, want in SELF_TEST:
            got = bool(triggers(paths, [f]))
            print(f"{'live' if got else 'replay only':12} {f}")
            if got != want:
                bad.append(f"{f}: expected {'live' if want else 'replay only'}")
        bad += fork_rule_problems(workflow)
        for b in bad:
            print(f"FAIL {b}", file=sys.stderr)
        print("self-test:", "FAIL" if bad else f"PASS ({len(SELF_TEST)} paths, fork rule held)")
        return 1 if bad else 0

    if args.files is not None:
        files = args.files
    elif args.base and args.head:
        if re.fullmatch(r"0+", args.base):  # first push of a branch: compare with main
            args.base = "origin/main"
        try:
            files = subprocess.run(
                ["git", "diff", "--name-only", args.base, args.head],
                check=True, capture_output=True, text=True, cwd=ROOT,
            ).stdout.split()
        except subprocess.CalledProcessError:
            print("could not diff; running live to be safe")
            write_output(True)
            return 0
    else:
        print("give --files, --base and --head, or --self-test", file=sys.stderr)
        return 2
    hits = triggers(paths, files)
    for f in hits:
        print(f"live trigger: {f}")
    print(f"live={'true' if hits else 'false'} ({len(hits)} of {len(files)} changed files match)")
    write_output(bool(hits))
    return 0


def write_output(live: bool) -> None:
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"live={'true' if live else 'false'}\n")


if __name__ == "__main__":
    sys.exit(main())
