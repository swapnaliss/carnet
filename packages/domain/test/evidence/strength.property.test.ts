// M2-03: the flag is deterministic (same input, same output, whatever order the documents arrive in)
// and monotone (adding a passing, verified document never worsens the flag).
import { describe, expect, it } from "vitest";
import {
  checkEvidence,
  EVIDENCE_FLAG_RANK,
  type EvidenceDocument,
  type EvidenceInput,
} from "../../src/index";
import { prng, RUNS } from "../prng";
import { amount, contract, doc, input, invoice, payment, text } from "./support";

function scenario(rand: ReturnType<typeof prng>) {
  const minor = rand.pick([50_000, 100_000, 100_001, 480_000, 9_999_999]);
  const prior = rand.pick([0, 0, 1, 3]);
  const p = payment({ amountMinor: BigInt(minor) });
  const good = {
    invoice: invoice({ total: amount("total", minor, "USD") }),
    po: doc("purchase_order", [amount("total", minor, "USD")]),
    contract: contract(),
    // A second, identical-in-substance verified invoice.
    invoice2: invoice({ total: amount("total", minor, "USD") }),
    other: doc("other", []),
  };
  const bad: EvidenceDocument[] = [
    invoice({ total: amount("total", minor + 1, "USD") }),
    invoice({
      supplier: text("supplier", "Someone Else Ltd"),
      total: amount("total", minor, "USD"),
    }),
    doc("invoice", [], { unusableKeys: ["total"] }),
    doc("purchase_order", [amount("total", minor + 7, "USD")]),
  ];
  const keys = ["invoice", "po", "contract", "other"] as const;
  const have = keys.filter(() => rand.int(0, 1) === 1);
  const base: EvidenceDocument[] = [
    ...have.map((k) => good[k]),
    ...(rand.int(0, 2) === 0 ? [rand.pick(bad)] : []),
  ];
  return { p, prior, base, good, keys, have, minor };
}

const withDocs = (p: ReturnType<typeof scenario>, docs: EvidenceDocument[]): EvidenceInput =>
  input({ payment: p.p, priorPayments: p.prior, documents: docs });

describe("evidence flag properties", () => {
  it("is deterministic and independent of document order", () => {
    const rand = prng(20261109);
    for (let i = 0; i < RUNS; i++) {
      const s = scenario(rand);
      const forward = checkEvidence(withDocs(s, s.base));
      const again = checkEvidence(withDocs(s, s.base));
      const reversed = checkEvidence(withDocs(s, [...s.base].reverse()));
      expect(again).toEqual(forward);
      expect(reversed).toEqual(forward);
    }
  });

  it("adding a passing, verified document never worsens the flag", () => {
    const rand = prng(20261110);
    let improved = 0;
    for (let i = 0; i < RUNS; i++) {
      const s = scenario(rand);
      const before = checkEvidence(withDocs(s, s.base));
      const candidates = [s.good.invoice2, s.good.contract, s.good.po, s.good.other].filter(
        (d) => !s.base.includes(d),
      );
      for (const added of candidates) {
        const after = checkEvidence(withDocs(s, [...s.base, added]));
        expect(
          EVIDENCE_FLAG_RANK[after.flag],
          `${before.flag} -> ${after.flag}`,
        ).toBeGreaterThanOrEqual(EVIDENCE_FLAG_RANK[before.flag]);
        if (EVIDENCE_FLAG_RANK[after.flag] > EVIDENCE_FLAG_RANK[before.flag]) improved++;
      }
    }
    expect(improved).toBeGreaterThan(0);
  });
});
