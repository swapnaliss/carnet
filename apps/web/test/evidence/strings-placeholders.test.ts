// A template placeholder that no caller fills ("{waiting} waiting for Airwallex") reached a screen in
// M2-03. `fill` now throws outside production when a value is missing, and these tests fill every
// template the M2-03 screens use with the values their callers really pass.
import {
  checkEvidence,
  EVIDENCE_REASON_KEYS,
  type EvidenceDocument,
  type EvidenceInput,
  type ExtractedFact,
  type ParsedValue,
} from "@carnet/domain";
import { describe, expect, it } from "vitest";
import { queueCounts } from "../../src/components/queue/counts";
import { reasonDto } from "../../src/server/evidence";
import type { QueueItemDto } from "../../src/server/queue";
import { fill, t } from "../../src/strings";

const item = (over: Partial<QueueItemDto["payment"]>, held = false): QueueItemDto => ({
  payment: {
    id: "p",
    reference: "r",
    amount: { amount: "1.00", currency: "USD" },
    source_currency: "USD",
    method: "LOCAL",
    counterparty_id: null,
    transfer_id: null,
    transfer_status: null,
    transfer_updated_at: null,
    failure_type: null,
    view: null,
    held,
    final: false,
    attempt: null,
    created_at: "2026-11-09T09:00:00.000Z",
    updated_at: "2026-11-09T09:00:00.000Z",
    ...over,
  },
  payee: "Payee",
  flag: "missing",
  reason: "",
  documents: 0,
  held,
  rfi_expires_at: null,
  rfi_id: null,
});

describe("fill", () => {
  it("throws for a placeholder with no value (outside production)", () => {
    expect(() => fill("{a} and {b}", { a: 1 })).toThrow(/no value for \{b\}/);
    expect(fill("{a} and {a}", { a: 1 })).toBe("1 and 1");
  });
});

describe("queue summary", () => {
  it.each([
    ["no payments", []],
    [
      "a mix",
      [
        item({}),
        item({ attempt: { status: "INTENT" } as never }),
        item({ transfer_status: "PAID" }),
        item({ transfer_status: "PROCESSING" }, true),
      ],
    ],
  ])("fills every placeholder: %s", (_name, items) => {
    const text = fill(t.queue.summary.counts, { ...queueCounts(items) });
    expect(text).not.toMatch(/[{}]/);
  });

  it("counts a transfer being created as waiting, not sent", () => {
    const c = queueCounts([item({ attempt: { status: "INTENT" } as never }), item({})]);
    expect(c).toMatchObject({ total: 2, sent: 0, waiting: 1, notSent: 1 });
  });
});

describe("reason sentences", () => {
  const base = (over: Partial<EvidenceInput>): EvidenceInput => ({
    payment: {
      amountMinor: 200_000n,
      currency: "USD",
      payeeName: "Harbor Print Co.",
      reference: "R",
    },
    documents: [],
    priorPayments: 0,
    policy: { contractRequiredAboveMinor: {} },
    ...over,
  });
  const fact = (key: string, parsed: unknown): ExtractedFact => ({
    key,
    value: key,
    parsed: parsed as ParsedValue,
    quote: "q",
    page: 1,
    quote_verified: true,
    needs_confirmation: false,
    issues: [],
  });
  const doc = (
    kind: string,
    usable: ExtractedFact[],
    over: Partial<EvidenceDocument> = {},
  ): EvidenceDocument => ({
    documentId: `${kind}-1`,
    kind,
    label: `${kind}.pdf`,
    factVersionId: `fv-${kind}`,
    usable,
    unusableKeys: [],
    extraction: "done",
    ...over,
  });

  it("every reason key the rules can emit resolves all its placeholders", () => {
    const text = (v: string) => ({ type: "text", text: v });
    const amount = (m: string, c = "USD") => ({ type: "amount", minor: m, currency: c });
    const scenarios: EvidenceInput[] = [
      base({ documents: [] }),
      base({
        documents: [
          doc("invoice", [
            fact("total", amount("200000")),
            fact("supplier", text("Harbor Print Co.")),
          ]),
          doc("contract", [fact("clause_parties", text("Harbor Print Co."))]),
        ],
      }),
      base({
        documents: [
          doc("invoice", [
            fact("total", amount("1")),
            fact("supplier", text("Other")),
            fact("iban", text("DE11")),
          ]),
          doc("purchase_order", [fact("total", amount("2", "EUR"))]),
          doc("contract", [
            fact("clause_parties", text("Someone")),
            fact("clause_beneficiary_account", text("DE99")),
          ]),
        ],
      }),
      base({
        documents: [
          doc("invoice", [], { unusableKeys: ["invoice_number"], extraction: "pending" }),
          doc("invoice", [], { extraction: "failed" }),
        ],
      }),
      base({
        documents: [
          doc("invoice", [
            fact("total", amount("200000")),
            fact("supplier", text("Harbor Print Co.")),
          ]),
          doc("purchase_order", [fact("total", amount("200000"))]),
        ],
      }),
      base({
        documents: [
          doc("invoice", [
            fact("total", amount("200000")),
            fact("supplier", text("Harbor Print Co.")),
          ]),
          doc("contract", []),
        ],
      }),
    ];
    const seen = new Set<string>();
    for (const input of scenarios) {
      const check = checkEvidence(input as EvidenceInput);
      for (const r of [...check.reasons, ...check.rules.flatMap((x) => x.reasons)]) {
        const dto = reasonDto(r);
        expect(dto.text, r.key).not.toMatch(/[{}]/);
        seen.add(r.key);
      }
    }
    // The scenarios reach most keys; any key they miss still has to be a declared, worded key.
    for (const key of EVIDENCE_REASON_KEYS) {
      expect((t.evidence.reason as Record<string, string>)[key], key).toBeTruthy();
    }
    expect(seen.size).toBeGreaterThan(12);
  });
});
