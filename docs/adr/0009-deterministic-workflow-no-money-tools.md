# ADR 0009: A deterministic workflow; the model has no money tools

Status: accepted (2 Nov 2026)

## Context
The blast radius of the agent is money. Judges score whether code enforces limits and the model judges.

## Decision
Three typed model calls: extract facts from a document, propose a criticality from a contract, draft answers to RFI questions. Each is a pure function from data to schema-validated JSON. Planning, policy, approvals and execution are code. The model holds no credentials and has no tool that can move money or call Airwallex. Documents and RFI text are untrusted data.

## Alternatives considered
An autonomous tool-calling agent with a payment tool.

## Consequences
Cost to reverse: low.
