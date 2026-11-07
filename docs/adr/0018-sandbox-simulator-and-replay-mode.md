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
