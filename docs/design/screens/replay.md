# Recording (judge replay)

From M4-05 (ADR 0018 amendment 2). Route: `/replay` (any signed-in user; no session redirects to
`/login`), plus the recording banner on every screen of a replay session and `/replay/payee`.

## Purpose

Let a judge walk a recorded real run (Airwallex sandbox and the real model, captured when it ran)
through the real screens, without touching our sandbox account, our model credits or live data, and
without ever mistaking the recording for something live. Honesty first: every value comes from a
recorded file, and the screen says so.

## Recording banner (every screen of a replay session)

- A full-width region under the header: `role=region`, accessible name "Recording notice"
  (`replay.bannerLabel`), warning tone (`status-warning-*` tokens), film icon (decorative).
- Text (`replay.banner`): "Recording of a real sandbox run on <date>. Nothing here is live." The date
  is the active recording's `run_date` (and `run_date_end`), formatted "12 November 2026 – 13 November 2026".
  With no recording loaded: `replay.bannerNoRecording`.
- A "What is real" link to `/replay#what-is-real`.
- Not dismissible. Present in the page title: "<Page> · Recording · Carnet".
- The owner sees a "Switch to live" button in the banner. The judge never does.
- Live owner session: the banner is replaced by a "LIVE" indicator (success tone, radio icon, text
  label, never colour alone) with "Switch to the recording".
- In replay every create / approve / edit control is hidden (the session is read-only; the API answers
  403 anyway).

## Timeline (`/replay`)

| Data | Source |
|---|---|
| Label, capture date, deployed version, models | the recording's manifest (`replay_recordings.manifest`) |
| Events | `replay_recordings.timeline`: time, kind, title, detail, source file, screen |
| Screen links | the event's route template resolved with the recording's refs (ids in the replay business) |

Layout, top to bottom: h1 "Recording", intro; per recording: h2 label and a definition list (Captured,
Deployed version, Models); the controls (Play / Pause, Previous step, Next step, Restart) as one
fieldset with a visually hidden legend "Replay controls"; the current step card (Step n of N · time,
title, detail, "Source: <file>" in mono, "Open this screen" link when the screen is loaded); then the
full ordered list as buttons (current step `aria-current="step"`, accent fill and a primary border);
finally the "What is real" section.

- **1440:** content max width; list rows show time (mono, fixed column) and title on one line.
- **768:** same, controls wrap.
- **375:** controls wrap two per row; list rows stack time above title; 44px minimum targets.

## Behaviour and keyboard

- Play advances one step every 2.5 s and stops at the last step; Pause stops; Restart goes to step 1.
- Previous / Next are disabled at the ends.
- Every control is a native button (Tab order: controls, step link, list). Arrow Up / Down on a list
  item moves the current step and focus.
- The current step card is a polite live region (the change is announced once, atomically).

## States

- **Loading:** title, a polite status line "Loading the recording", skeletons for the controls, the
  card and six rows (`loading.tsx`).
- **Empty:** "No recording loaded" with how to load one (`npm run demo:reset`).
- **Error:** "The recording could not be loaded", what to do, a Reload button; focus moves to the
  heading (`error.tsx`).
- **Timeline only:** a recording whose screens are not loaded shows its events without links and the
  note `replay.page.notMaterialized`.

## Payee page (`/replay/payee`)

The public payee view (status word and time) for the recorded Harbor payment, with the same recording
notice above the card and "· Recording" in the title. Replay sessions only (others get the
unavailable page, 404).
