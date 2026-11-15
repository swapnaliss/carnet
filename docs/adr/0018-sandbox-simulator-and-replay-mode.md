# ADR 0018: Sandbox simulator port and labelled replay mode

Status: accepted (2 Nov 2026)

## Context
Sandbox-only simulation calls must be replaceable, and the product path must not contain mocks.

## Decision
A `SandboxSimulator` port calls only real Airwallex `/simulation/*` endpoints. If the plain sandbox account cannot create simulated RFIs, a local injection of the documented webhook shape goes through the same signature verification and is labelled in the UI and disclosed in the README. Judge access uses a replay of a recorded real run, clearly labelled as a recording. Tests replay recorded real responses.

## Alternatives considered
Local fakes that bypass verification; unlabelled demo data.

## Consequences
Cost to reverse: low.

## Amendment 1 (6 Nov 2026, M2-04): the open-RFI rule is per type and source

Status: accepted (owner decision 2026-11-04, BL-01 6600617735)

**Context.** The M0-04 spike observed that Airwallex rejects a second open RFI with the same type **and the
same source** (400 `invalid_state_for_operation`, `rfi-oneopen-second-create-while-open`), while RFIs on
another source, or with no source, are open at the same time (`rfi-check7-create-other-source-while-open`).
The original planning assumption, one open Transaction RFI per account, was stricter than the provider.

**Decision.**
- Carnet does not rely on a global "one open RFI per account" rule. It keeps its own **per-source guard**:
  for one business, at most one open RFI per (type, source key), where the source key is the sorted set of
  `TYPE:id` sources on the RFI's questions. An RFI without sources has no key and is not guarded (the
  provider lets those coexist). "Open" is every Carnet state except `CLOSED` and `EXPIRED` (the provider
  requires the earlier RFI to be `CLOSED`, so `ANSWERED` still counts).
- A second open RFI with the same key reaching ingest is **stored and flagged `conflict`**, surfaced to the
  owner, and never merged into the first. The guard is enforced in one transaction under a per-business
  advisory lock, backed by a partial unique index.
- The sandbox account stays an **exclusive planning resource**: transfers, balances and the webhook
  subscription are shared, even though RFIs on different sources coexist.

**Consequences.** Simulated RFIs for different transfers can run in parallel in tests and the demo; the
conflict flag is the owner-visible signal if the provider ever sends two for one source. Cost to reverse: low.

## Amendment 2 (15 Nov 2026, M4-05): replay is a session mode over a recorded business

Status: accepted (ticket M4-05; owner approved the early start)

**Context.** Judges must use the product without our sandbox account, our model credits or our live data,
and the replay must drive the real screens, not hard-coded UI. Drafts, facts, policies and the audit log
are immutable for the app role (no DELETE), so a recorded run cannot be wiped and reloaded in place.

**Decision.**
- The mode (`live` or `replay`) is a column of the better-auth session row (`auth_sessions.mode`, migration
  0019), never a client flag. A `viewer` (the judge login) is always `replay`, whatever the row says. Only
  the owner may switch (`PUT /api/v1/session/mode`, the one route with `allowInReplay`).
- A replay session reads a **replay business** through the same repositories (`sessionCtx` swaps the
  business id), and every non-GET request is 403 in replay, for every role. Nothing in replay reaches
  Airwallex or the model: the only web-tier calls to either are behind mutating routes.
- Recordings live in `fixtures/replay/<id>/manifest.json`. `npm run demo:reset` builds each recording's
  ordered timeline from its recorded files and stores it in `replay_recordings`; a recording with a
  materializer (`m2-pipeline`) is loaded into its own business by the real pipelines replaying recorded
  responses. The business id is derived from the recording's fingerprint: an unchanged recording is kept,
  a changed one becomes a new generation. A recording without a materializer (the M3-07 capture until one
  is written) shows its timeline only.
- The database is marked as a demo database by migration 0019 (`demo_database`); the reset refuses one
  without the marker.

**Consequences.** Old replay generations stay in the database unreferenced (immutable rows). The approval
and respond rows of the recorded run are shown on the timeline from the recorded files, not re-created.
Cost to reverse: low.
