---
title: "M5-SUBMIT · Submit (owner; repo made public with owner's OK)"
milestone: "M5 · Submission"
labels: ["owner"]
blocked_by: ["M5-GATE"]
estimate: "1h"
resources: []
needs: ["P-14", "P-15", "P-16"]
---

## Context

The last step is the owner's alone. The rules say code must be public at submission, and the repo has
stayed private by design; making it public is irreversible in effect (it becomes visible and may be
cached or forked), so it happens only with the owner's explicit go-ahead recorded on this issue, and
only after `M5-GATE` has passed on the merge commit. Nothing here is automated.

Deadline: 15 Nov 2026 23:59 IST (18:29 UTC) per the owner's reading of the HackerEarth event data,
unless Slack confirmed 13 Nov (record whichever the owner confirmed in `M5-03`). The plan is ready on
14 Nov; 15 Nov is buffer.

## Scope

1. Confirm `M5-GATE` passed on the commit that is on `main` (compare SHAs on the issue).
2. The owner writes an explicit go-ahead on this issue ("make the repo public"). Only then:
   change `swapnaliss/carnet` visibility to public (Settings, Danger zone), or ask the worker to run
   the visibility change after the written go-ahead.
3. Open the repo URL in a logged-out browser window; confirm the README renders, the licence shows,
   no internal path is visible, and the deployed demo and video links in it work.
4. Submit on HackerEarth before the confirmed deadline using the drafted text from `M5-03`: demo URL,
   video link, repo link, the zip if the form accepts one, team and members.
5. Record the submission confirmation (screenshot with no secrets, plus the confirmation text and
   timestamp) on this issue.
6. Keep the Demo Day plan: 19 Nov 2026 in San Francisco, remote participation optional; record the
   owner's decision (attend remotely or not) and what to have ready (the warm deployed app, the
   replay-mode login, the video).

## Out of scope

- Fixing code after the gate (a fix needs a new green gate; if the owner chooses to fix, reopen `M5-GATE`)
- Targeting the Visa or Metal prizes
- Rewriting history, deleting issues or PRs

## Acceptance Criteria

- [ ] The owner's explicit go-ahead is recorded on the issue before visibility changes
- [ ] The repo URL opens in a logged-out browser and shows the README and licence (checked by `curl` returning 200 without credentials and by eye)
- [ ] The submission confirmation (text, timestamp, screenshot) is recorded on the issue and is earlier than the confirmed deadline
- [ ] The Demo Day decision (19 Nov, remote optional) is recorded on the issue

## Deliverables

- Issue comments: go-ahead, public repo URL check, submission confirmation, Demo Day decision

## Validation Gate

```bash
set -euo pipefail
: "${REPO_URL:?set to the public repo URL}"
# run only after the owner's go-ahead and the visibility change
curl -fsSL -o /dev/null -w '%{http_code}\n' "$REPO_URL"            # logged out: expect 200
curl -fsSL "$REPO_URL" | grep -qi 'carnet'
tmp=$(mktemp -d "$TMPDIR/public.XXXX")
git clone -q "$REPO_URL" "$tmp/c" && ! (cd "$tmp/c" && git ls-files | grep -E '^(PROJECT|WORKFLOW|CLAUDE)\.md$|^\.github/plan/')
date -u +%FT%TZ   # compare with the deadline 2026-11-15T18:29:00Z (or the Slack-confirmed date)
```

## Handoff → done

Comment: the public repo URL, the submission confirmation and timestamp, and the Demo Day plan.
