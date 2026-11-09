import { describe, expect, it } from "vitest";
import { checkEvidence, EVIDENCE_REASON_KEYS } from "../../src/index";
import { amount, contract, doc, input, invoice, payment, text } from "./support";

describe("strength flag", () => {
  it("Strong: every applicable rule passes", () => {
    const c = checkEvidence(input({ documents: [invoice()] }));
    expect(c.flag).toBe("strong");
    expect(c.reasons.map((r) => r.key)).toEqual(["allPassed"]);
  });

  it("Missing: no invoice linked", () => {
    const c = checkEvidence(input({ documents: [contract()] }));
    expect(c.flag).toBe("missing");
    expect(c.reasons[0]?.key).toBe("noInvoice");
    expect(checkEvidence(input()).flag).toBe("missing");
  });

  it("Missing: a required contract is not linked at all", () => {
    const c = checkEvidence(
      input({
        priorPayments: 0,
        payment: payment({ amountMinor: 100_001n }),
        documents: [invoice({ total: amount("total", 100_001, "USD") })],
      }),
    );
    expect(c.flag).toBe("missing");
    expect(c.reasons.map((r) => r.key)).toContain("contractMissing");
  });

  it("the threshold boundary: equal is Strong, +1 without a contract is Missing", () => {
    const at = (minor: number, docs = [invoice({ total: amount("total", minor, "USD") })]) =>
      checkEvidence(
        input({
          priorPayments: 0,
          payment: payment({ amountMinor: BigInt(minor) }),
          documents: docs,
        }),
      );
    expect(at(100_000).flag).toBe("strong");
    expect(at(100_001).flag).toBe("missing");
    expect(
      at(100_001, [invoice({ total: amount("total", 100_001, "USD") }), contract()]).flag,
    ).toBe("strong");
  });

  it("Weak: a rule fails, with the reasons in rule order", () => {
    const c = checkEvidence(
      input({
        documents: [
          invoice({
            total: amount("total", 480_001, "USD"),
            supplier: text("supplier", "Other Co"),
          }),
        ],
      }),
    );
    expect(c.flag).toBe("weak");
    expect(c.reasons.map((r) => r.key)).toEqual(["amountMismatch", "payeeMismatch"]);
  });

  it("Weak, not Missing: an invoice is linked but a fact is unverified", () => {
    const c = checkEvidence(
      input({
        documents: [
          doc("invoice", [text("supplier", "Harbor Print Co.")], { unusableKeys: ["total"] }),
        ],
      }),
    );
    expect(c.flag).toBe("weak");
    expect(c.reasons.map((r) => r.key)).toEqual(
      expect.arrayContaining(["amountNoFact", "unverifiedFact"]),
    );
  });

  it("a Weak reason never repeats the positive findings", () => {
    const c = checkEvidence(
      input({ documents: [invoice({ supplier: text("supplier", "Other Co") })] }),
    );
    expect(c.reasons.map((r) => r.key)).toEqual(["payeeMismatch"]);
  });

  it("every reason key is declared", () => {
    const c = checkEvidence(input({ documents: [invoice({ total: amount("total", 1, "EUR") })] }));
    for (const r of [...c.reasons, ...c.rules.flatMap((x) => x.reasons)]) {
      expect(EVIDENCE_REASON_KEYS).toContain(r.key);
    }
  });

  it("lists the fact versions it used and binds a hash to them", () => {
    const inv = invoice();
    const a = checkEvidence(input({ documents: [inv] }));
    expect(a.fact_version_ids).toEqual([inv.factVersionId]);
    const b = checkEvidence(input({ documents: [{ ...inv, factVersionId: "fv-other" }] }));
    expect(b.check_hash).not.toBe(a.check_hash);
    expect(a.check_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
