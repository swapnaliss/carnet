---
title: "M5-GATE · Clean-clone gate"
milestone: "M5 · Submission"
labels: ["gate"]
blocked_by: ["M5-01", "M5-02", "M5-03", "M5-CLEANUP"]
estimate: "2h"
resources: []
needs: ["P-02", "P-09"]
---

## Context

This is the last gate. It runs **after** `M5-CLEANUP`, from a clean clone of the merge commit, so it
proves what a judge will actually get: a public tree with no workflow files, a README that works
when followed literally, evidence that backs every claim, a deployed app that answers, and a video
that plays. It does **not** block on `M5-SUBMIT`: submitting is the owner's decision after this passes.

## Scope

Run every check below from a fresh clone in a temp directory, never from the working directory:

1. No private path is tracked (the `INTERNAL` pattern from `M5-CLEANUP`).
2. No tracked file cites an untracked workflow file or an untracked repo path (`PROJECT.md`,
   `CLAUDE.md`, `WORKFLOW.md`, `.github/plan/`, `docs/research/`, `.kickoff-state.md`, internal docs).
3. `./scripts/landing-checks.sh` passes.
4. `npm ci`, `make up`, the full test suite pass on the clone.
5. The README "How to run" is executed **literally**, line by line, in a second empty directory with
   only the owner-provided keys supplied through the environment; the app reaches a working state
   (home page loads, owner login works, replay-mode judge login shows the labelled recording).
6. Evidence files present: `docs/evidence/{evals,load-test,a11y-cwv,m2-run,m3-run}.md`, and every
   number in the README appears in them.
7. Secret scan over the **full history** and the working tree.
8. The deployed app answers `/healthz` with 200 and serves the judge login.
9. The demo video link is reachable without login and its duration is 3:00 or less.
10. The zip from `M5-03` rebuilt with `git archive` from the merge commit is clean (no `.env`, no `.git`, no internal paths).

## Out of scope

- Fixing failures (open a BL-01 entry or a fix PR, then re-run the gate)
- Making the repository public or submitting (`M5-SUBMIT`)
- Rewriting history

## Acceptance Criteria

- [ ] `git ls-files` on the clone lists no internal path (command output on the issue)
- [ ] The citation check prints nothing
- [ ] `./scripts/landing-checks.sh`, `npm ci`, tests all exit 0 on the clone; CI is green on the merge commit
- [ ] The README "How to run" executed literally reaches a working app (steps and outcome recorded)
- [ ] All five evidence files exist and every README number is found in them
- [ ] The history scan reports no findings
- [ ] The deployed `/healthz` returns 200; the video link returns 200 and its duration is at most 180 seconds
- [ ] The rebuilt zip passes the content checks
- [ ] Merge commit SHA and each result are posted on the issue

## Deliverables

- A gate comment with the merge commit SHA and the output of each check
- BL-01 entries for anything found and accepted or deferred

## Validation Gate

```bash
set -euo pipefail
: "${DEPLOY_URL:?set to the deployed app URL}" "${VIDEO_URL:?set to the unlisted video link}"
sha=$(git rev-parse HEAD)
tmp=$(mktemp -d "$TMPDIR/m5gate.XXXX")
git clone -q . "$tmp/c"; git -C "$tmp/c" checkout -q "$sha"
cd "$tmp/c"
INTERNAL='^(\.github/plan/|PROJECT\.md$|WORKFLOW\.md$|CLAUDE\.md$|\.claude/(commands|agents)/|scripts/(waves|bootstrap_github|check-prereqs|check-plan)\.py$|docs/(engineering-standards|PREREQS|budget)\.md$)'
! git ls-files | grep -E "$INTERNAL"
! git grep -nE 'PROJECT\.md|WORKFLOW\.md|CLAUDE\.md|\.github/plan|docs/research|kickoff-state' -- . ':!.gitignore'
missing=$(git grep -hoE '(docs|scripts|infra|fixtures|\.github)/[A-Za-z0-9_./-]+\.(md|ts|tsx|js|mjs|json|ya?ml|sh|py)' | sort -u | while read -r p; do git ls-files --error-unmatch -- "$p" >/dev/null 2>&1 || echo "$p"; done)
[ -z "$missing" ] || { printf 'MISSING:\n%s\n' "$missing"; exit 1; }
./scripts/landing-checks.sh
npm ci
make up
npm test
for f in evals load-test a11y-cwv m2-run m3-run; do test -s "docs/evidence/$f.md"; done
grep -oE '[0-9]+(\.[0-9]+)?( ?%| ?ms| ?s| rps| cases)' README.md | sort -u | while read -r n; do grep -rqF -- "$n" docs/evidence/ || { echo "NOT IN EVIDENCE: $n"; exit 1; }; done
gitleaks detect --source . --redact
gitleaks detect --no-git --source . --redact
curl -fsS -o /dev/null -w '%{http_code}\n' "$DEPLOY_URL/healthz"
curl -fsSIL -o /dev/null -w '%{http_code}\n' "$VIDEO_URL"
git archive --format=zip -o "$tmp/carnet.zip" HEAD
! unzip -Z1 "$tmp/carnet.zip" | grep -E '(^|/)\.env$|^\.git/'
make down
# literal README run: open README.md "How to run" in a second empty temp dir and execute each command in order; record the result
```

## Handoff → M5-SUBMIT

Comment: the merge commit SHA, pass/fail per check, the README run transcript summary (no values), and
any accepted BL-01 entries. `M5-SUBMIT` may proceed only on a pass and the owner's explicit go-ahead.
