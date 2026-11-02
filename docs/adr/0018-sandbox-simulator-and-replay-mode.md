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
