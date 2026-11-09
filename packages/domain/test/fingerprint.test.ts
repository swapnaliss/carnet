// M2-06 AC 1: the same question in a different case, spacing or punctuation has the same fingerprint;
// a changed digit, word, counterparty or answer type has a different one.
import { describe, expect, it } from "vitest";
import { FP_VERSION, fingerprint, normalizeQuestionText } from "../src/index";
import { prng, RUNS } from "./prng";

const CP = "11111111-1111-4111-8111-111111111111";
const OTHER_CP = "22222222-2222-4222-8222-222222222222";
const fp = (questionText: string, counterpartyId = CP, answerType = "TEXT") =>
  fingerprint({ counterpartyId, questionText, answerType });

describe("normalizeQuestionText", () => {
  const cases: [string, string][] = [
    ["Please provide the INVOICE for this payment.", "please provide the invoice for this payment"],
    [
      "  Please   provide\tthe\ninvoice,  for this payment!! ",
      "please provide the invoice for this payment",
    ],
    ["What is the purpose of the payment?", "what is the purpose of the payment"],
    ["Company’s  registered   address", "companys registered address"],
    ["ＩＮＶＯＩＣＥ ｎｕｍｂｅｒ", "invoice number"],
    ["Total: $4,800.00 (USD)", "total $4,800.00 usd"],
    ["Invoice INV-2024-001", "invoice inv 2024-001"],
    ["Paid on 2024-01-05.", "paid on 2024-01-05"],
    ["", ""],
  ];
  it.each(cases)("%j", (input, expected) => {
    expect(normalizeQuestionText(input)).toBe(expected);
  });
  it("is idempotent", () => {
    for (const [input] of cases) {
      const once = normalizeQuestionText(input);
      expect(normalizeQuestionText(once)).toBe(once);
    }
  });
});

describe("fingerprint", () => {
  it("is 64 lower-case hex characters and carries a version", () => {
    expect(fp("Why?")).toMatch(/^[0-9a-f]{64}$/);
    expect(FP_VERSION).toBe(1);
  });

  it("ignores case, spacing and punctuation", () => {
    const base = fp("Please provide the invoice for this payment.");
    for (const variant of [
      "PLEASE PROVIDE THE INVOICE FOR THIS PAYMENT",
      "please   provide the invoice\nfor this payment",
      "Please, provide the invoice for this payment?!",
      "  “Please provide the invoice for this payment”  ",
    ]) {
      expect(fp(variant), variant).toBe(base);
    }
  });

  it("changes with a digit, a word, an added clause, the counterparty or the answer type", () => {
    const base = fp("Provide invoice 4821 dated 2024-01-05 for USD 4,800.00");
    for (const variant of [
      "Provide invoice 4822 dated 2024-01-05 for USD 4,800.00",
      "Provide invoice 4821 dated 2024-01-06 for USD 4,800.00",
      "Provide invoice 4821 dated 2024-01-05 for USD 4,800.01",
      "Provide invoice 4821 dated 2024-01-05 for USD 4.800.00",
      "Provide invoice 4821 dated 2024-01-05 for USD 48,00.00",
      "Provide invoices 4821 dated 2024-01-05 for USD 4,800.00",
      "Provide invoice 4821 dated 2024-01-05 for EUR 4,800.00",
      "Provide invoice 4821 dated 2024-01-05 for USD 4,800.00 and the contract",
    ]) {
      expect(fp(variant), variant).not.toBe(base);
    }
    expect(fp("Provide invoice 4821 dated 2024-01-05 for USD 4,800.00", OTHER_CP)).not.toBe(base);
    expect(fp("Provide invoice 4821 dated 2024-01-05 for USD 4,800.00", CP, "ATTACHMENT")).not.toBe(
      base,
    );
  });

  it("does not stem or match synonyms", () => {
    expect(fp("Provide the invoice")).not.toBe(fp("Provide the invoices"));
    expect(fp("Provide the invoice")).not.toBe(fp("Supply the invoice"));
  });
});

describe("fingerprint properties", () => {
  const WORDS = [
    "invoice",
    "contract",
    "payment",
    "USD",
    "4800",
    "2024-01-05",
    "supplier",
    "goods",
  ];
  const { next } = prng(20260211);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const sentence = () => Array.from({ length: 3 + Math.floor(next() * 6) }, () => pick(WORDS));

  it("case, whitespace and trailing punctuation never change it", () => {
    for (let i = 0; i < RUNS; i++) {
      const words = sentence();
      const plain = words.join(" ");
      const noisy = `  ${words
        .map((w) => (next() < 0.5 ? w.toUpperCase() : w))
        .join(next() < 0.5 ? "   " : "\n")}${pick(["", ".", "?", "!!", " ;"])}  `;
      expect(fp(noisy)).toBe(fp(plain));
    }
  });

  it("changing one digit of the text always changes it", () => {
    for (let i = 0; i < RUNS; i++) {
      const text = `${sentence().join(" ")} ${Math.floor(next() * 90000) + 10000}`;
      const digits = [...text.matchAll(/\d/g)];
      const at = (pick(digits) as RegExpMatchArray).index as number;
      const changed = (Number(text[at]) + 1 + Math.floor(next() * 8)) % 10;
      const mutated = text.slice(0, at) + changed + text.slice(at + 1);
      expect(fp(mutated), `${text} -> ${mutated}`).not.toBe(fp(text));
    }
  });

  it("changing the counterparty always changes it", () => {
    for (let i = 0; i < RUNS; i++) {
      const text = sentence().join(" ");
      expect(fp(text, CP)).not.toBe(fp(text, OTHER_CP));
    }
  });
});
