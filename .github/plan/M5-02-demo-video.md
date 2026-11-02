---
title: "M5-02 · Demo video ≤3 min (worker drafts script/shot list; owner records)"
milestone: "M5 · Submission"
labels: ["owner", "docs"]
blocked_by: ["M4-GATE"]
estimate: "6h"
resources: []
needs: []
---

## Context

The portal asks for a short video walkthrough under five minutes; we target three minutes or less.
Judges decide in the first 30 seconds, so the video leads with the pain in users' own words, then
shows the real sandbox run. It claims only what a recorded run or an eval shows (`docs/evidence/`).

Split: the worker prepares everything that can be prepared (script, shot list, checklist, commands).
The owner records and uploads, because only the owner can run the live session and hold the accounts.

## Scope

**Worker:**

1. `docs/outreach/video-script.md` (gitignored; never committed): a narration script with timings
   following the storyboard (0:00 pain quoted with sources; 0:25 goal, plan, evidence flags, one weak;
   0:50 two payments clear and one is sent; 1:10 an RFI arrives from the real sandbox and the payment
   shows HELD FOR INFORMATION and the plan re-runs; 1:30 cited drafts, the verifier catching a mutated
   draft, bound approval, submit; 2:05 the revised plan executes, a conversion auto-executes under its
   limit, an alternate payout needs approval, the transfer reaches SENT or PAID on its own status;
   2:25 a follow-up reopens a question and the approved answer is reused in one click; 2:45 limits and
   future vision). Every spoken number is traced to an evidence file in the script's margin notes.
2. A shot list: per shot the screen, the click path, the seed state needed and the on-screen caption.
3. A pre-flight checklist: deployed app warm (`/healthz` answers, one request made), replay mode off
   for the owner's login, the sandbox reset to a known state, exactly one open RFI at a time (the
   exclusive Airwallex sandbox rule), the Anthropic spend cap checked, notifications silenced, window
   size fixed, a backup recording of the replay-mode run in case the live run fails.
4. ffmpeg commands (copyable, with `$TMPDIR` paths) for trimming, concatenating takes, speeding idle
   waits with a visible "2x" caption, burning captions from an `.srt`, and a final encode (H.264,
   1080p, AAC) with a duration check via `ffprobe`.
5. A short on-video disclosure line for the replay and sandbox-only status, and the fallback line if
   the ADR 0018 fallback was used.

**Owner:** run the pre-flight, record, trim, upload as an **unlisted** link, and post the link on this
issue. Re-record if the video shows a secret, a real person's data or an error not discussed.

## Out of scope

- Editing the README (`M5-01`) beyond receiving the link
- Any claim not backed by `docs/evidence/` or a recorded run; any mock or staged success
- Targeting Visa or Metal prizes

## Acceptance Criteria

- [ ] `docs/outreach/video-script.md` exists, is gitignored (`git check-ignore` succeeds) and covers every storyboard step
- [ ] Shot list, pre-flight checklist and ffmpeg commands are present in the same file
- [ ] The final video is 3:00 or shorter (`ffprobe` duration recorded on the issue)
- [ ] The video shows the real sandbox run (a real RFI from the sandbox) and the verifier rejecting a mutated draft
- [ ] The unlisted link plays in a logged-out browser and is recorded on the issue
- [ ] No secret, API key or `.env` content is visible in any frame (owner checked, noted on the issue)

## Deliverables

- `docs/outreach/video-script.md` (gitignored)
- The unlisted video link on this issue
- The local final file (not committed; kept for the HackerEarth upload if requested)

## Validation Gate

```bash
set -euo pipefail
git check-ignore -q docs/outreach/video-script.md
f=docs/outreach/video-script.md
for k in "pre-flight" "ffmpeg" "shot list" "mutated" "follow-up" "limits"; do grep -qi -- "$k" "$f" || { echo "missing: $k"; exit 1; }; done
! grep -nE '(sk-ant|AKIA|BEGIN [A-Z ]*PRIVATE KEY)' "$f"
# owner step: set VIDEO to the final local file, then
# d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO"); awk -v d="$d" 'BEGIN{exit !(d<=180)}'
# link reachability: curl -sI "$VIDEO_URL" | head -1   (expect 200)
```

## Handoff → M5-01 (link), M5-03, M5-GATE

Comment: the unlisted link, the duration, the date recorded and the commit or deployment it shows.
`M5-01` puts the link in the README Demo section; `M5-GATE` checks that the link is reachable.
