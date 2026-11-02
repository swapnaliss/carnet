---
title: "BL-01 · Backlog: bugs, gaps, pitfalls and constraints found during the build"
milestone: "M5 · Submission"
labels: ["meta"]
blocked_by: []
estimate: "0h"
resources: []
needs: []
---

## Context

Every problem found mid-ticket is a fork: fix it now and lose the ticket, or forget it and lose the finding. This issue is the third option. Findings are logged with `/backlog`, fixed ticket by ticket in `/start` Phase 7b, swept after every passed gate (`/gate` step 8), and what remains at submission becomes the README's **Limits** section and the *future vision* material.

## Scope

Triage the remaining open entries at submission: fix, accept as a documented limitation, or move to the future vision. Keep this issue's body as the entry format reference.

### Entry format (each entry is a comment)

```
### <YYYY-MM-DD HH:MM> · found in <TICKET-ID> · <type>
**What:**        <one line>
**Impact:**      <what breaks or is at risk>
**Workaround:**  <what we did instead, or "none — deferred">
**Action:**      <fix now | fix before submission | accept as limitation | document in architecture>
**Owner ticket:** <ticket id whose scope it belongs to, or "this ticket">
**Status:** open
```

Types: `bug`, `gap`, `pitfall`, `constraint`, `assumption-wrong`, `perf`, `security`, `data-quality`. The `**Owner ticket:**` and `**Status:**` lines are updated in place by the backlog pass and the post-gate sweep (`open` to `fixed in <PR>` or `accepted`).

## Out of scope

- Building features (a missing feature is a ticket, never a backlog entry)

## Acceptance Criteria

- [ ] Every entry is `fixed`, `accepted` (with the limitation stated in the README) or moved to the future vision
- [ ] No entry is `open` at the submission gate

## Deliverables

- The README **Limits** section updated from the accepted entries

## Validation Gate

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh issue view "$(python3 -c "import json;print(json.load(open('.github/plan/issue-map.json'))['BL-01'])")" -R "$REPO" --comments | grep -c '\*\*Status:\*\* open'   # expect 0 at submission
```

## Handoff → M5-01 (README Limits), M5-GATE

Comment the count of accepted limitations and where each is stated.
