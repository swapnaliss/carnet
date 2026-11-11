// M2-03: every rule with its pass, fail and missing cases (table-driven).
import { describe, expect, it } from "vitest";
import {
  contractRequired,
  EVIDENCE_REASON_KEYS,
  normalizeName,
  ruleAmount,
  ruleConsistent,
  ruleContract,
  rulePayee,
  ruleVerified,
} from "../../src/index";
import { amount, contract, doc, input, invoice, payment, text, unverified } from "./support";

describe("normalizeName", () => {
  it.each([
    ["Harbor Print Co.", "harbor print"],
    ["HARBOR PRINT, LLC", "harbor print"],
    ["  harbor   print inc ", "harbor print"],
    ["Rheinblick Druck GmbH", "rheinblick druck"],
    ["Müller & Söhne GmbH", "muller and sohne"],
    ["Co", "co"],
  ])("%s -> %s", (raw, expected) => expect(normalizeName(raw)).toBe(expected));

  it("keeps a near match different", () => {
    expect(normalizeName("Harbour Print Co.")).not.toBe(normalizeName("Harbor Print Co."));
  });
});

describe("R-AMT", () => {
  const run = (docs: Parameters<typeof input>[0], p = payment()) =>
    ruleAmount(input({ ...docs, payment: p }));

  it.each([
    ["exact total", amount("total", 480_000, "USD"), "pass"],
    ["off by one minor unit (+1)", amount("total", 480_001, "USD"), "fail"],
    ["off by one minor unit (-1)", amount("total", 479_999, "USD"), "fail"],
    ["currency mismatch, same digits", amount("total", 480_000, "EUR"), "fail"],
  ] as const)("%s -> %s", (_name, total, outcome) => {
    const r = run({ documents: [invoice({ total })] });
    expect(r?.outcome).toBe(outcome);
    if (outcome === "fail") expect(r?.reasons[0]?.params.invoice).toBeTruthy();
  });

  it("reports a currency mismatch with its own reason", () => {
    const r = run({ documents: [invoice({ total: amount("total", 480_000, "EUR") })] });
    expect(r?.reasons[0]?.key).toBe("amountCurrencyMismatch");
    expect(r?.reasons[0]?.params).toMatchObject({
      payment: "USD 4,800.00",
      invoice: "EUR 4,800.00",
    });
  });

  it("passes when any linked invoice has the total", () => {
    const r = run({
      documents: [invoice({ total: amount("total", 1, "USD") }), invoice()],
    });
    expect(r?.outcome).toBe("pass");
  });

  it("is missing when the invoice has no usable total", () => {
    const r = run({ documents: [doc("invoice", [text("supplier", "Harbor Print Co.")])] });
    expect(r?.outcome).toBe("missing");
  });

  it("does not apply without an invoice", () => {
    expect(run({ documents: [] })).toBeNull();
  });

  it("cites the fact versions it read", () => {
    const inv = invoice();
    const r = ruleAmount(input({ documents: [inv] }));
    expect(r?.fact_version_ids).toEqual([inv.factVersionId]);
  });
});

describe("R-PAYEE", () => {
  it.each([
    ["same", "Harbor Print Co.", "pass"],
    ["case and punctuation", "HARBOR PRINT CO", "pass"],
    ["another legal suffix", "Harbor Print, LLC", "pass"],
    ["supplier near match", "Harbour Print Co.", "fail"],
    ["a different company", "Lakeside Freight LLC", "fail"],
  ] as const)("%s -> %s", (_name, supplier, outcome) => {
    const r = rulePayee(input({ documents: [invoice({ supplier: text("supplier", supplier) })] }));
    expect(r?.outcome).toBe(outcome);
    if (outcome === "fail") {
      expect(r?.reasons[0]).toMatchObject({
        key: "payeeMismatch",
        params: { payee: "Harbor Print Co.", invoice: supplier },
      });
    }
  });

  it("is missing when the supplier fact is absent", () => {
    const r = rulePayee(input({ documents: [doc("invoice", [amount("total", 480_000, "USD")])] }));
    expect(r?.outcome).toBe("missing");
  });
});

describe("R-CONTRACT", () => {
  const at = (minor: bigint, prior: number, docs = [invoice(), contract()]) =>
    input({ payment: payment({ amountMinor: minor }), priorPayments: prior, documents: docs });

  it("applies only to a first payment strictly above the threshold", () => {
    expect(contractRequired(at(100_000n, 0))).toBe(false); // equal
    expect(contractRequired(at(100_001n, 0))).toBe(true); // +1
    expect(contractRequired(at(99_999n, 0))).toBe(false);
    expect(contractRequired(at(10_000_000n, 1))).toBe(false); // not the first payment
  });

  it("uses the configured threshold per currency and a default otherwise", () => {
    const eur = input({
      payment: payment({ amountMinor: 100_001n, currency: "EUR" }),
      priorPayments: 0,
      policy: { contractRequiredAboveMinor: { USD: 1n } },
    });
    expect(contractRequired(eur)).toBe(true); // default 100000 for EUR
    expect(
      contractRequired({ ...eur, payment: payment({ amountMinor: 100_000n, currency: "EUR" }) }),
    ).toBe(false);
  });

  it("equal to the threshold: not applicable, no contract needed", () => {
    expect(ruleContract(at(100_000n, 0, [invoice()]))).toBeNull();
  });

  it("+1 over the threshold without a contract: missing", () => {
    const r = ruleContract(at(100_001n, 0, [invoice()]));
    expect(r?.outcome).toBe("missing");
    expect(r?.reasons[0]?.key).toBe("contractMissing");
  });

  it("+1 over the threshold with a contract naming the payee: pass", () => {
    expect(ruleContract(at(100_001n, 0))?.outcome).toBe("pass");
  });

  it("a contract naming someone else: fail with both names", () => {
    const r = ruleContract(
      at(100_001n, 0, [
        invoice(),
        contract("Northwind Studio Ltd (Buyer) and Lakeside Freight LLC (Supplier)."),
      ]),
    );
    expect(r?.outcome).toBe("fail");
    expect(r?.reasons[0]?.params.contract).toContain("Lakeside");
  });

  it("a contract whose parties are not a usable fact: missing, not pass", () => {
    const r = ruleContract(at(100_001n, 0, [invoice(), doc("contract", [])]));
    expect(r?.outcome).toBe("missing");
    expect(r?.reasons[0]?.key).toBe("contractNoFact");
  });
});

describe("R-VERIFIED", () => {
  it("passes when every linked document has only usable facts", () => {
    expect(ruleVerified(input({ documents: [invoice()] }))?.outcome).toBe("pass");
  });
  it("fails and names an unusable fact", () => {
    const r = ruleVerified(input({ documents: [doc("invoice", [], { unusableKeys: ["total"] })] }));
    expect(r?.outcome).toBe("fail");
    expect(r?.reasons[0]).toMatchObject({ key: "unverifiedFact", params: { fact: "total" } });
  });
  it("is missing while extraction runs or after it failed", () => {
    for (const [extraction, key] of [
      ["pending", "extractionPending"],
      ["failed", "extractionFailed"],
    ] as const) {
      const r = ruleVerified(input({ documents: [doc("invoice", [], { extraction })] }));
      expect(r?.outcome).toBe("missing");
      expect(r?.reasons[0]?.key).toBe(key);
    }
  });
  it("does not apply with no documents", () => {
    expect(ruleVerified(input())).toBeNull();
  });
});

describe("R-CONSISTENT", () => {
  const po = (minor: number, currency = "USD") =>
    doc("purchase_order", [amount("total", minor, currency)]);
  it("passes when invoice and PO totals agree", () => {
    expect(ruleConsistent(input({ documents: [invoice(), po(480_000)] }))?.outcome).toBe("pass");
  });
  it.each([
    ["one minor unit apart", po(480_001)],
    ["another currency", po(480_000, "EUR")],
  ])("fails when totals differ: %s", (_n, p) => {
    const r = ruleConsistent(input({ documents: [invoice(), p] }));
    expect(r?.outcome).toBe("fail");
    expect(r?.reasons.map((x) => x.key)).toContain("totalsDiffer");
  });
  it("fails when the invoice account is not the contract's", () => {
    const r = ruleConsistent(
      input({
        documents: [
          invoice({ extra: [text("iban", "DE44000000000000000099")] }),
          doc("contract", [
            text(
              "clause_beneficiary_account",
              "Supplier is paid only to IBAN DE11000000000000000001.",
            ),
          ]),
        ],
      }),
    );
    expect(r?.outcome).toBe("fail");
    expect(r?.reasons[0]?.key).toBe("accountsDiffer");
  });
  it("passes when the contract names the invoice account", () => {
    const r = ruleConsistent(
      input({
        documents: [
          invoice({ extra: [text("iban", "DE11 0000 0000 0000 0000 01")] }),
          doc("contract", [
            text(
              "clause_beneficiary_account",
              "Supplier is paid only to IBAN DE11000000000000000001.",
            ),
          ]),
        ],
      }),
    );
    expect(r?.outcome).toBe("pass");
  });
  it("does not apply when a side has no usable fact", () => {
    expect(ruleConsistent(input({ documents: [invoice()] }))).toBeNull();
    expect(ruleConsistent(input({ documents: [invoice(), doc("purchase_order", [])] }))).toBeNull();
  });
});

describe("unverified facts never contribute to a pass", () => {
  it("a rule given only unusable facts cannot pass", () => {
    // The loader hands the rules the usable facts only; an unverified fact is therefore absent.
    const bad = doc("invoice", [], { unusableKeys: ["total", "supplier"] });
    for (const r of [
      ruleAmount(input({ documents: [bad] })),
      rulePayee(input({ documents: [bad] })),
    ]) {
      expect(r?.outcome).toBe("missing");
    }
    expect(unverified(amount("total", 1, "USD")).quote_verified).toBe(false);
  });
});

describe("reason keys", () => {
  it("every emitted key is declared", () => {
    const declared = new Set<string>(EVIDENCE_REASON_KEYS);
    const results = [
      ruleAmount(input({ documents: [invoice({ total: amount("total", 5, "EUR") })] })),
      rulePayee(input({ documents: [invoice({ supplier: text("supplier", "X") })] })),
      ruleContract(
        input({
          payment: payment({ amountMinor: 200_000n }),
          priorPayments: 0,
          documents: [invoice()],
        }),
      ),
    ];
    for (const r of results)
      for (const x of r?.reasons ?? []) expect(declared.has(x.key)).toBe(true);
  });
});
