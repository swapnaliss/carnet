---
title: "M0-01 · Organiser questions and Slack outreach (deadline Nov 13 vs 15, AWS credits, RFI sandbox, rubric)"
milestone: "M0 · Recon & Bootstrap"
labels: ["owner"]
blocked_by: []
estimate: "1h"
resources: []
needs: []
---

## Context

Several answers change the plan and only the organisers can give them (PROJECT.md §10: "Deadline unclear (13 vs 15 Nov)", "Prior-work and AI-use rules unanswered", "A plain sandbox account cannot create simulated RFIs", "Hosting undecided until M0-07"). Asking on day one costs one hour; discovering a disqualifying rule on day twelve costs the project. The answers feed the rubric mapping R0–R9 (PROJECT.md §7), the hosting decision (M0-07) and the RFI spike (M0-04).

## Scope

The owner posts the questions in the hackathon Slack and records the answers; a worker drafts the question text and the answer log. **Owner action: only the owner can post in the organisers' Slack**, so this ticket carries the `owner` label.

Worker drafts `docs/outreach/organiser-questions.md` (gitignored; confirm with `git check-ignore`), one short message per question, each stating why it matters and what the team will do under each answer:

1. Final submission deadline: 13 Nov or 15 Nov, 18:29 UTC? (Plan submission-ready on 14 Nov either way.)
2. The judging rubric: is it the "Build around a financial decision" list in the builder guide (R0–R9), or is there a scored rubric with weights?
3. Are AWS credits available to hackathon teams, how are they claimed, and how long do they take? (Gates M0-07.)
4. Can a plain sandbox account (no `x-on-behalf-of`) create simulated RFIs with `POST /simulation/rfis/create`? If not, is a platform or Connect test account available, or is local injection of the documented webhook shape acceptable if labelled?
5. Prior-work and AI-use wording: may code be written with AI assistance, and does the build window rule out any existing code? (Carnet is written inside the window; ask anyway.)
6. May one project be entered for two prizes?
7. Does Airwallex deliver webhooks from a fixed IP range that must be allowlisted on the host?

Also in the file: an **Answers** table (question, answer, who answered, date, link to the Slack message) that the owner fills in. After each answer the worker (or owner) states which plan item changes, if any, and opens a `BL-01` entry for it.

## Out of scope

- Changing the plan from an answer (that goes to `BL-01`, or to the owner for a milestone change)
- Posting anything about the product design or sharing keys, URLs of private repos, or the sandbox account id
- Waiting for answers: downstream tickets proceed on the stated defaults; answers adjust them later

## Acceptance Criteria

- [ ] `docs/outreach/organiser-questions.md` exists, is gitignored, and has all seven questions with a "if the answer is X we do Y" line each
- [ ] The owner has posted the questions (link or date recorded in the Answers table)
- [ ] Every answer received is in the Answers table with its source; unanswered rows say "no answer yet, default: ..." with the default
- [ ] No secret, key or private URL appears in the file

## Deliverables

- `docs/outreach/organiser-questions.md` (private, gitignored)
- A short comment on the issue summarising answers and plan impact

## Validation Gate

```bash
set -euo pipefail
f=docs/outreach/organiser-questions.md
test -s "$f"
git check-ignore -q "$f"
n=$(grep -c -E '^[0-9]+\. ' "$f"); [ "$n" -ge 7 ]
grep -q -i 'answers' "$f"
grep -q -i 'deadline' "$f" && grep -q -i 'aws' "$f" && grep -q -i 'x-on-behalf-of\|simulat' "$f"
if grep -E -i '(api[_-]?key|secret|token)\s*[:=]\s*[A-Za-z0-9]{12,}' "$f"; then echo "secret-like value" >&2; exit 1; fi
./scripts/check-no-secrets.sh
```

## Handoff

- M0-07 needs the AWS credits answer (and the deadline) before the owner decides on a host.
- M0-04 needs the RFI-simulation answer to know whether a platform account exists; the spike still runs on the plain account first.
- M5 tickets need the final deadline and the two-prize answer.
- Post on the issue: the Answers table (text, no private links), and any plan change raised in `BL-01`.
