---
title: "M5-03 · Submission checklist + HackerEarth artefacts (zip, repo link)"
milestone: "M5 · Submission"
labels: ["owner", "docs"]
blocked_by: ["M5-01", "M5-02"]
estimate: "2h"
resources: []
needs: []
---

## Context

Submission is a one-shot action on HackerEarth. Everything it asks for is prepared and rehearsed
before the deadline so the last step is a copy and paste. The portal's stated requirements: a working
demo, a video under five minutes, and a link to the repository with setup instructions. HackerEarth's
generic FAQ also mentions a zip upload (and says a video is not mandatory): we make all of them.

The deadline is the owner's confirmed date. The owner plans against 15 Nov 2026 23:59 IST (18:29 UTC)
per HackerEarth event data; the landing page says 13 Nov. The date the owner confirmed in Slack
(`M0-01`) is recorded here and governs.

## Scope

1. **Checklist** (kept in the issue body, not in a tracked file): working demo URL (deployed app, judge
   login, replay mode labelled), video link (under 5 minutes, ours is 3 minutes or less), repository
   link with setup instructions (README "How to run"), zip of the clean tree, submission description,
   team and members, eligibility (18 or older, team of at most four), the confirmed deadline and
   time zone conversion.
2. **Zip artefact**: after `M5-CLEANUP` is merged, produce the zip with `git archive` of the clean
   tree at the merge commit (tracked files only; no `.git`, no `.env`, no untracked workflow files).
   Record the commit SHA, size and file count.
3. **Dry run of the form**: list every field the HackerEarth submission form has (owner reads them
   from the portal and pastes the field names on the issue), and draft the text for each; do not
   press submit.
4. **Submission description**: drafted from the README Problem, Solution, Limits and measured
   claims (same numbers, nothing new); includes the sandbox-only/synthetic statement and the replay
   disclosure.
5. **Team and members confirmation**: names, count, ages, contact; the owner confirms on the issue.
6. **Prizes**: the Visa and Metal awards are explicitly not targeted (they need Visa or Metal tooling);
   the submission targets the open categories only. State this in the checklist.
7. **Final secrets scan** on the working tree, the zip contents and the full history.

Because the zip should reflect the clean tree, the final zip is built or rebuilt once `M5-CLEANUP`
has merged; this ticket records the procedure and a dry-run zip from the current tree, and the owner
re-runs the build command after cleanup (the result is re-verified by `M5-GATE`).

## Out of scope

- Making the repository public and pressing submit (`M5-SUBMIT`)
- Editing the README or the video (`M5-01`, `M5-02`)
- Paid add-ons, sponsor-tooling integrations for the Visa or Metal prizes

## Acceptance Criteria

- [ ] The checklist is on the issue with every item either ticked with evidence or marked owner-pending
- [ ] The confirmed deadline and its source (Slack message date) are recorded
- [ ] A zip built with `git archive` exists, contains no `.env`, no `.git` and no internal paths, and its SHA-256 is on the issue
- [ ] The secrets scan over the tree, the zip and the full history reports no findings
- [ ] Every form field has a drafted answer on the issue; the description text matches README numbers (each appears in `docs/evidence/`)
- [ ] Team and members confirmed by the owner on the issue
- [ ] The Visa and Metal prizes are stated as not targeted

## Deliverables

- The checklist and drafted form text as an issue comment
- The zip built outside the repo (`$TMPDIR` or the owner's downloads folder); never committed

## Validation Gate

```bash
set -euo pipefail
tmp=$(mktemp -d "$TMPDIR/submit.XXXX")
git archive --format=zip -o "$tmp/carnet.zip" HEAD
unzip -l "$tmp/carnet.zip" | tail -1
! unzip -Z1 "$tmp/carnet.zip" | grep -E '(^|/)\.env$|^\.git/'
# internal paths only matter after M5-CLEANUP; the same command is re-run by M5-GATE
unzip -Z1 "$tmp/carnet.zip" | grep -E '^(PROJECT|WORKFLOW|CLAUDE)\.md$|^\.github/plan/' && echo "WARN: run again after M5-CLEANUP" || true
sha256sum "$tmp/carnet.zip"
x="$tmp/x"; mkdir "$x" && unzip -q "$tmp/carnet.zip" -d "$x"
gitleaks detect --no-git --source "$x" --redact
gitleaks detect --source . --redact
./scripts/check-no-secrets.sh
```

## Handoff → M5-CLEANUP, M5-GATE, M5-SUBMIT

Comment: the checklist, the confirmed deadline, the zip procedure and dry-run SHA-256, the drafted form
text. `M5-GATE` rebuilds and re-checks the zip from the cleaned tree; `M5-SUBMIT` pastes the drafted text.
