---
title: "M5-01 · README for judges"
milestone: "M5 · Submission"
labels: ["docs"]
blocked_by: ["M4-GATE"]
estimate: "5h"
resources: []
needs: []
---

## Context

The README is the first and often only thing a judge reads. The skeleton in `README.md` has one
placeholder per section, each naming the ticket that fills it. This ticket fills every one of them
from verified sources and recorded evidence. The README is public: it must make sense after
`M5-CLEANUP` untracks the workflow files, so it links only to files that stay tracked
(`docs/architecture.md`, `docs/adr/`, `docs/evidence/`, `docs/screenshots/`, `LICENSE`, `.env.example`).

Claims discipline: the README claims only what a test, an eval or a recorded run shows. Every number
comes from `docs/evidence/` (`evals.md`, `load-test.md`, `a11y-cwv.md`, `m2-run.md`, `m3-run.md`).
Quotes are verbatim with a source link and date; stated facts are separated from inference.

## Scope

Fill each placeholder in `README.md`, keeping the existing title, tagline, sandbox-only line and
licence section:

1. **Problem**: the pain in users' words, with links and dates for each quote (re-open each link on
   the day and confirm the quote is verbatim; drop any that no longer verifies). Who suffers, what it
   costs, why it is unsolved. Use the four evidence rows (frozen account with payroll due; repeated
   requests for the same documents; suppliers chasing a payment nobody can see; the Airwallex docs
   wording on what a review asks for). Label inference as inference ("the pain is provider-wide; only
   Airwallex's RFI API is demonstrable in the sandbox").
2. **Solution**: end to end in plain language (state the goal, evidence check, approve and send, a
   payment is held, cited drafts, one bound approval, plan revised, outcome tracked, follow-up reuse)
   and the differentiation answer (Airwallex ships RFI answering screens but no automation; say only
   what was verified).
3. **Why now**: Airwallex's RFI API and simulators, agentic banking, governed execution.
4. **Architecture**: the system diagram pasted from `docs/architecture.md` and a 5-line summary of the
   controls (bound approvals, execution attempts with unknown-outcome resolution, grounded drafting and
   the verifier, code decides and the model judges, audit chain). Keep the links to the architecture
   doc and ADRs.
5. **Demo**: placeholder links filled with the unlisted video link from `M5-02` (under 3 minutes), the
   deployed URL, and screenshots of the hold screen and the plan screen taken from `docs/screenshots/`
   or `docs/evidence/`. Link text states that the judge login serves a labelled replay.
6. **Evals and measured claims**: results from `docs/evidence/evals.md` (case count, grounded-answer
   rate, mutation-rejection rate, trajectory results), `docs/evidence/load-test.md` (the scaling
   numbers as measured), `docs/evidence/a11y-cwv.md`, and the run evidence in `m2-run.md` and
   `m3-run.md`. Each number is followed by a link to its evidence file. A metric the evidence does not
   show is not claimed (the planning targets such as event-to-draft p95 appear only if a recorded run
   measured them).
7. **Future vision**: other providers' information requests, accountants managing many small clients,
   account-level and onboarding reviews, a payment-readiness score before sending; labelled as not built.
8. **How to run**: prerequisites with versions (Node 24, npm 11, Docker, Python only if a script needs
   it), `make up`, the environment variables by name from `.env.example` (no values), the seed script,
   Airwallex sandbox signup and API key, the webhook subscription (public HTTPS URL; polling works
   without it), the Anthropic key, how to log in as the owner, and replay-mode login for judges plus
   the demo reset command. Every command is copied from a real run, not written from memory.
9. **Limits**: honest limits. Take every BL-01 entry accepted as a limitation, the Airwallex behaviours
   that were unverified or turned out different in the M0 spikes (as recorded in `docs/evidence/` and
   the ADRs), the sandbox-only and synthetic-data statement, the replay-mode disclosure (the judge
   login plays back a recorded real run), and the fallback disclosure (if the ADR 0018 fallback was
   used because the plain sandbox could not create simulated RFIs: say that RFIs were injected locally
   through the same signature check and are labelled "sandbox-injected"; if it was not used, say so in
   one line). Also: Airwallex RFIs only, no payee contact, no bypass of any provider's review.

Add a rule note that the README does not mention the Visa or Metal prizes as targets.

## Out of scope

- Writing the video script (`M5-02`) or the submission form text (`M5-03`)
- New measurements, new features or new evidence files (a number with no evidence is removed, not measured here)
- Linking to `PROJECT.md`, `CLAUDE.md`, `WORKFLOW.md`, `.github/plan/`, `docs/research/` or `.kickoff-state.md`
- Untracking files (`M5-CLEANUP`)

## Acceptance Criteria

- [ ] No `<!-- M5-01` or other placeholder comment remains in `README.md`
- [ ] Every number in the README appears in a file under `docs/evidence/` (script check below prints nothing)
- [ ] Every quote in Problem is verbatim, dated and linked; each link opened on the day
- [ ] Every relative link in the README resolves to a tracked file and none points to an internal path
- [ ] The Limits section contains each BL-01 entry marked accepted, the unverified-behaviour list, the sandbox-only/synthetic statement, the replay-mode disclosure and the ADR 0018 fallback statement (used or not)
- [ ] No secret value or `.env` content appears (`./scripts/check-no-secrets.sh` passes)
- [ ] A fresh clone follows "How to run" and reaches a working app (executed literally in `M5-GATE`)

## Deliverables

- `README.md` (all sections filled)
- Screenshots in `docs/screenshots/` if any are missing (taken from the running app or recorded run)

## Validation Gate

```bash
set -euo pipefail
! grep -n '<!-- M5-' README.md
# internal paths must not be cited
! grep -nE 'PROJECT\.md|CLAUDE\.md|WORKFLOW\.md|\.github/plan|docs/research|kickoff-state' README.md
# every relative link target exists
grep -oE '\]\((\.?/?[A-Za-z0-9_./-]+)\)' README.md | sed -E 's/^\]\(//; s/\)$//' | grep -v '^http' | while read -r p; do [ -e "$p" ] || { echo "BROKEN: $p"; exit 1; }; done
# every number with a unit or percent must appear in an evidence file
tmp=$(mktemp -d "$TMPDIR/readme.XXXX")
grep -oE '[0-9]+(\.[0-9]+)?( ?%| ?ms| ?s| rps| cases)' README.md | sort -u > "$tmp/nums"
while read -r n; do grep -rqF -- "$n" docs/evidence/ || echo "NOT IN EVIDENCE: $n"; done < "$tmp/nums" | tee "$tmp/missing"
[ ! -s "$tmp/missing" ]
./scripts/check-no-secrets.sh
```

## Handoff → M5-02, M5-03, M5-GATE

Comment: the README section list as filled, the Demo placeholders still awaiting the `M5-02` video link,
the Limits entries copied from BL-01, and whether the ADR 0018 fallback disclosure says "used" or "not used".
`M5-03` reuses the Problem, Solution and Limits text for the submission description; `M5-GATE` executes "How to run" literally.
