// Evidence rules (M2-03, Pillar 1, R5): pure functions that judge whether the documents linked to a
// payment would survive a review. The judgement is made by code from facts that are quote-verified or
// owner-confirmed (the `usable` facts of M2-02); the model is not involved. Unverified facts never
// reach a rule, so they can only ever count as absent.
//
// Each rule returns `{rule, outcome, reasons, fact_version_ids}`. Reasons are keys into the strings
// module (`evidence.reason.<key>`) with plain-text parameters, so the screens can say them in words.
import type { ExtractedFact } from "./fact-schemas";

export const EVIDENCE_RULE_IDS = [
  "R-AMT",
  "R-PAYEE",
  "R-CONTRACT",
  "R-VERIFIED",
  "R-CONSISTENT",
] as const;
export type EvidenceRuleId = (typeof EVIDENCE_RULE_IDS)[number];

export type RuleOutcome = "pass" | "fail" | "missing";

/** Every reason key a rule or the flag can emit; apps/web/src/strings.ts has `evidence.reason.<key>`. */
export const EVIDENCE_REASON_KEYS = [
  "noInvoice",
  "amountMatch",
  "amountMismatch",
  "amountCurrencyMismatch",
  "amountNoFact",
  "payeeMatch",
  "payeeMismatch",
  "payeeNoFact",
  "contractNamesPayee",
  "contractNamesOther",
  "contractNoFact",
  "contractMissing",
  "verifiedAll",
  "unverifiedFact",
  "extractionFailed",
  "extractionPending",
  "totalsAgree",
  "totalsDiffer",
  "accountsAgree",
  "accountsDiffer",
  "allPassed",
] as const;
export type EvidenceReasonKey = (typeof EVIDENCE_REASON_KEYS)[number];

export interface EvidenceReason {
  readonly key: EvidenceReasonKey;
  readonly params: Readonly<Record<string, string>>;
}

export interface RuleResult {
  readonly rule: EvidenceRuleId;
  readonly outcome: RuleOutcome;
  readonly reasons: readonly EvidenceReason[];
  /** Ids of the stored fact versions whose facts the rule read (sorted, no duplicates). */
  readonly fact_version_ids: readonly string[];
}

export interface EvidencePayment {
  readonly amountMinor: bigint;
  readonly currency: string;
  /** The counterparty's name as Carnet holds it. */
  readonly payeeName: string;
  readonly reference: string;
}

/** The state of a linked document's extraction. */
export type ExtractionState = "none" | "pending" | "failed" | "done";

export interface EvidenceDocument {
  readonly documentId: string;
  /** DOCUMENT_KINDS value. */
  readonly kind: string;
  /** Shown in reasons (the filename). */
  readonly label: string;
  /** The id of the latest stored fact version, null while none exists. */
  readonly factVersionId: string | null;
  /** The facts evidence may use (`usableFacts`): verified or owner-confirmed, nothing else. */
  readonly usable: readonly ExtractedFact[];
  /** Keys of facts in the latest version that are not usable (unverified, image-only, unparseable). */
  readonly unusableKeys: readonly string[];
  /** `none` for a kind that has no extraction; `pending` before the first version exists. */
  readonly extraction: ExtractionState;
}

export interface EvidencePolicy {
  /** A first payment to a counterparty above this many minor units needs a contract. Per currency. */
  readonly contractRequiredAboveMinor: Readonly<Record<string, bigint>>;
}

/** Applied to a currency the business has not configured: 1,000.00 in a two-decimal currency. */
export const DEFAULT_CONTRACT_THRESHOLD_MINOR = 100_000n;

export interface EvidenceInput {
  readonly payment: EvidencePayment;
  readonly documents: readonly EvidenceDocument[];
  /** Payments to the same counterparty before this one. */
  readonly priorPayments: number;
  readonly policy: EvidencePolicy;
}

export function contractThreshold(policy: EvidencePolicy, currency: string): bigint {
  return policy.contractRequiredAboveMinor[currency] ?? DEFAULT_CONTRACT_THRESHOLD_MINOR;
}

// ---------------------------------------------------------------------------------------------
// Names

const LEGAL_SUFFIXES = new Set([
  "gmbh",
  "ag",
  "kg",
  "ug",
  "llc",
  "llp",
  "lp",
  "ltd",
  "limited",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "bv",
  "nv",
  "sa",
  "sarl",
  "srl",
  "spa",
  "plc",
  "pty",
  "oy",
  "ab",
  "as",
]);

/**
 * The deterministic form two names are compared in: Unicode-normalised, lower case, diacritics and
 * punctuation removed, `&` read as "and", and trailing legal suffixes dropped ("Harbor Print Co." and
 * "HARBOR PRINT, LLC" both become "harbor print"). A near match ("Harbour Print") stays different.
 */
export function normalizeName(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 0);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1] ?? "")) words.pop();
  return words.join(" ");
}

function compactId(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, "").toUpperCase();
}

// ---------------------------------------------------------------------------------------------
// Helpers

const reason = (key: EvidenceReasonKey, params: Record<string, string> = {}): EvidenceReason => ({
  key,
  params,
});

const sortedUnique = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

function money(minor: bigint | string, currency: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${currency} ${whole}.${digits.slice(-2)}`;
}

function textOf(fact: ExtractedFact): string | null {
  return fact.parsed?.type === "text" ? fact.parsed.text : null;
}

function factsOf(docs: readonly EvidenceDocument[], kind: string, key: string) {
  const out: { doc: EvidenceDocument; fact: ExtractedFact }[] = [];
  for (const doc of docs) {
    if (doc.kind !== kind) continue;
    for (const fact of doc.usable) if (fact.key === key) out.push({ doc, fact });
  }
  return out;
}

const ofKind = (docs: readonly EvidenceDocument[], kind: string) =>
  docs.filter((d) => d.kind === kind);

const versionIds = (...docs: (EvidenceDocument | undefined)[]) =>
  sortedUnique(docs.flatMap((d) => (d?.factVersionId ? [d.factVersionId] : [])));

// ---------------------------------------------------------------------------------------------
// Rules. A rule that does not apply to the payment returns null.

/** R-AMT: an invoice total equals the payment amount and currency exactly (integer minor units). */
export function ruleAmount(input: EvidenceInput): RuleResult | null {
  const invoices = ofKind(input.documents, "invoice");
  if (invoices.length === 0) return null; // the flag reports the missing invoice
  const { payment } = input;
  const totals = factsOf(input.documents, "invoice", "total").filter(
    (t) => t.fact.parsed?.type === "amount",
  );
  const paying = money(payment.amountMinor, payment.currency);
  if (totals.length === 0) {
    return {
      rule: "R-AMT",
      outcome: "missing",
      reasons: [reason("amountNoFact", { payment: paying })],
      fact_version_ids: versionIds(...invoices),
    };
  }
  const exact = totals.find(({ fact }) => {
    const p = fact.parsed;
    return (
      p?.type === "amount" &&
      p.currency === payment.currency &&
      BigInt(p.minor) === payment.amountMinor
    );
  });
  if (exact) {
    return {
      rule: "R-AMT",
      outcome: "pass",
      reasons: [reason("amountMatch", { amount: paying, document: exact.doc.label })],
      fact_version_ids: versionIds(exact.doc),
    };
  }
  const reasons = totals.flatMap(({ doc, fact }) => {
    const p = fact.parsed;
    if (p?.type !== "amount") return [];
    const invoiceAmount = money(p.minor, p.currency);
    return [
      reason(p.currency === payment.currency ? "amountMismatch" : "amountCurrencyMismatch", {
        payment: paying,
        invoice: invoiceAmount,
        document: doc.label,
        page: String(fact.page),
      }),
    ];
  });
  return {
    rule: "R-AMT",
    outcome: "fail",
    reasons,
    fact_version_ids: versionIds(...totals.map((t) => t.doc)),
  };
}

/** R-PAYEE: the invoice supplier matches the payee after normalisation; near matches are mismatches. */
export function rulePayee(input: EvidenceInput): RuleResult | null {
  const invoices = ofKind(input.documents, "invoice");
  if (invoices.length === 0) return null;
  const payee = normalizeName(input.payment.payeeName);
  const suppliers = factsOf(input.documents, "invoice", "supplier").flatMap(({ doc, fact }) => {
    const text = textOf(fact);
    return text === null ? [] : [{ doc, fact, text }];
  });
  if (suppliers.length === 0) {
    return {
      rule: "R-PAYEE",
      outcome: "missing",
      reasons: [reason("payeeNoFact", { payee: input.payment.payeeName })],
      fact_version_ids: versionIds(...invoices),
    };
  }
  const match = suppliers.find((s) => normalizeName(s.text) === payee);
  if (match) {
    return {
      rule: "R-PAYEE",
      outcome: "pass",
      reasons: [
        reason("payeeMatch", { payee: input.payment.payeeName, document: match.doc.label }),
      ],
      fact_version_ids: versionIds(match.doc),
    };
  }
  return {
    rule: "R-PAYEE",
    outcome: "fail",
    reasons: suppliers.map((s) =>
      reason("payeeMismatch", {
        payee: input.payment.payeeName,
        invoice: s.text,
        document: s.doc.label,
        page: String(s.fact.page),
      }),
    ),
    fact_version_ids: versionIds(...suppliers.map((s) => s.doc)),
  };
}

/** Whether R-CONTRACT applies: the first payment to a counterparty, strictly above the threshold. */
export function contractRequired(input: EvidenceInput): boolean {
  return (
    input.priorPayments === 0 &&
    input.payment.amountMinor > contractThreshold(input.policy, input.payment.currency)
  );
}

/** R-CONTRACT: a contract naming the counterparty is present (first payment above the threshold). */
export function ruleContract(input: EvidenceInput): RuleResult | null {
  if (!contractRequired(input)) return null;
  const contracts = ofKind(input.documents, "contract");
  if (contracts.length === 0) {
    return {
      rule: "R-CONTRACT",
      outcome: "missing",
      reasons: [reason("contractMissing", { payee: input.payment.payeeName })],
      fact_version_ids: [],
    };
  }
  const payee = normalizeName(input.payment.payeeName);
  const parties = factsOf(input.documents, "contract", "clause_parties").flatMap(
    ({ doc, fact }) => {
      const text = textOf(fact);
      return text === null ? [] : [{ doc, fact, text }];
    },
  );
  if (parties.length === 0) {
    return {
      rule: "R-CONTRACT",
      outcome: "missing",
      reasons: [reason("contractNoFact", { payee: input.payment.payeeName })],
      fact_version_ids: versionIds(...contracts),
    };
  }
  // Compare on normalised words with the legal suffix kept out of the way: the clause text names both
  // parties, so look for the payee's normalised words in the normalised clause.
  const names = parties.find((p) => ` ${normalizeClause(p.text)} `.includes(` ${payee} `));
  if (names) {
    return {
      rule: "R-CONTRACT",
      outcome: "pass",
      reasons: [
        reason("contractNamesPayee", { payee: input.payment.payeeName, document: names.doc.label }),
      ],
      fact_version_ids: versionIds(names.doc),
    };
  }
  return {
    rule: "R-CONTRACT",
    outcome: "fail",
    reasons: parties.map((p) =>
      reason("contractNamesOther", {
        payee: input.payment.payeeName,
        contract: p.text,
        document: p.doc.label,
        page: String(p.fact.page),
      }),
    ),
    fact_version_ids: versionIds(...parties.map((p) => p.doc)),
  };
}

/** A clause's text with every legal suffix dropped, so "Harbor Print Co. (Supplier)" holds "harbor print". */
function normalizeClause(text: string): string {
  const words = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 0 && !LEGAL_SUFFIXES.has(w));
  return words.join(" ");
}

/** R-VERIFIED: every fact a document offers is verified or confirmed; otherwise it counts as absent. */
export function ruleVerified(input: EvidenceInput): RuleResult | null {
  if (input.documents.length === 0) return null;
  const reasons: EvidenceReason[] = [];
  let outcome: RuleOutcome = "pass";
  for (const doc of input.documents) {
    if (doc.extraction === "failed") {
      outcome = "missing";
      reasons.push(reason("extractionFailed", { document: doc.label }));
    } else if (doc.extraction === "pending") {
      outcome = "missing";
      reasons.push(reason("extractionPending", { document: doc.label }));
    }
    if (doc.unusableKeys.length > 0) {
      if (outcome === "pass") outcome = "fail";
      for (const key of [...doc.unusableKeys].sort()) {
        reasons.push(reason("unverifiedFact", { document: doc.label, fact: key }));
      }
    }
  }
  if (outcome === "pass") reasons.push(reason("verifiedAll"));
  return {
    rule: "R-VERIFIED",
    outcome,
    reasons,
    fact_version_ids: versionIds(...input.documents),
  };
}

/**
 * R-CONSISTENT: the linked documents do not contradict each other. The invoice total equals the
 * purchase order total; the invoice's account (IBAN or account number) is the account the contract
 * names. Compared only where both sides have a usable fact.
 */
export function ruleConsistent(input: EvidenceInput): RuleResult | null {
  const reasons: EvidenceReason[] = [];
  const used: (EvidenceDocument | undefined)[] = [];
  let failed = false;

  const invoiceTotals = factsOf(input.documents, "invoice", "total");
  const poTotals = factsOf(input.documents, "purchase_order", "total");
  for (const po of poTotals) {
    const p = po.fact.parsed;
    if (p?.type !== "amount") continue;
    const comparable = invoiceTotals.filter((i) => i.fact.parsed?.type === "amount");
    const agreeing = comparable.find((i) => {
      const q = i.fact.parsed;
      return q?.type === "amount" && q.currency === p.currency && q.minor === p.minor;
    });
    if (agreeing) {
      used.push(agreeing.doc, po.doc);
      reasons.push(reason("totalsAgree", { total: money(p.minor, p.currency) }));
      continue;
    }
    for (const i of comparable) {
      const q = i.fact.parsed;
      if (q?.type !== "amount") continue;
      failed = true;
      used.push(i.doc, po.doc);
      reasons.push(
        reason("totalsDiffer", {
          invoice: money(q.minor, q.currency),
          purchaseOrder: money(p.minor, p.currency),
          invoiceDocument: i.doc.label,
          purchaseOrderDocument: po.doc.label,
        }),
      );
    }
  }

  const contractAccounts = factsOf(
    input.documents,
    "contract",
    "clause_beneficiary_account",
  ).flatMap(({ doc, fact }) => {
    const text = textOf(fact);
    return text === null ? [] : [{ doc, id: compactId(text) }];
  });
  const invoiceAccounts = [
    ...factsOf(input.documents, "invoice", "iban"),
    ...factsOf(input.documents, "invoice", "account_number"),
  ].flatMap(({ doc, fact }) => {
    const text = textOf(fact);
    return text === null ? [] : [{ doc, raw: text, id: compactId(text) }];
  });
  if (contractAccounts.length > 0 && invoiceAccounts.length > 0) {
    for (const account of invoiceAccounts) {
      const named = contractAccounts.some((c) => c.id.includes(account.id));
      used.push(account.doc, ...contractAccounts.map((c) => c.doc));
      if (named) {
        reasons.push(reason("accountsAgree", { account: account.raw }));
      } else {
        failed = true;
        reasons.push(
          reason("accountsDiffer", {
            invoice: account.raw,
            invoiceDocument: account.doc.label,
            contractDocument: contractAccounts[0]?.doc.label ?? "",
          }),
        );
      }
    }
  }

  if (reasons.length === 0) return null;
  return {
    rule: "R-CONSISTENT",
    outcome: failed ? "fail" : "pass",
    reasons: dedupe(reasons),
    fact_version_ids: versionIds(...used),
  };
}

function dedupe(reasons: EvidenceReason[]): EvidenceReason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const k = JSON.stringify([r.key, Object.entries(r.params).sort()]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The applicable rules, in the fixed order of EVIDENCE_RULE_IDS. */
export function evaluateRules(input: EvidenceInput): RuleResult[] {
  return [
    ruleAmount(input),
    rulePayee(input),
    ruleContract(input),
    ruleVerified(input),
    ruleConsistent(input),
  ].filter((r): r is RuleResult => r !== null);
}
