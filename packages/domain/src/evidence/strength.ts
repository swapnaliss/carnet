// The evidence strength flag (M2-03): Strong, Weak or Missing, decided by code from the rule results.
//   Missing  no invoice is linked, or a required contract is not linked at all
//   Weak     at least one applicable rule fails, or a fact it needs is unverified or absent
//   Strong   every applicable rule passes
// The same input always gives the same flag, reasons and hash (documents are put in id order first).

import { canonicalJson, sha256Hex } from "../planner/sha256";
import {
  contractRequired,
  type EvidenceInput,
  type EvidenceReason,
  type EvidenceReasonKey,
  evaluateRules,
  type RuleResult,
} from "./rules";

export const EVIDENCE_FLAGS = ["strong", "weak", "missing"] as const;
export type EvidenceFlag = (typeof EVIDENCE_FLAGS)[number];

/** Strong is best. Used to state "never worsens" in tests and to sort the queue. */
export const EVIDENCE_FLAG_RANK: Readonly<Record<EvidenceFlag, number>> = {
  missing: 0,
  weak: 1,
  strong: 2,
};

const POSITIVE: ReadonlySet<EvidenceReasonKey> = new Set([
  "amountMatch",
  "payeeMatch",
  "contractNamesPayee",
  "verifiedAll",
  "totalsAgree",
  "accountsAgree",
  "allPassed",
]);

export interface EvidenceCheck {
  readonly flag: EvidenceFlag;
  /** Ordered, in words once rendered from the strings module. Never empty. */
  readonly reasons: readonly EvidenceReason[];
  readonly rules: readonly RuleResult[];
  /** Every fact version any rule read (sorted). */
  readonly fact_version_ids: readonly string[];
  /** SHA-256 of the flag, the rules and their reasons: an acknowledgement is bound to it. */
  readonly check_hash: string;
}

export function checkEvidence(raw: EvidenceInput): EvidenceCheck {
  const input: EvidenceInput = {
    ...raw,
    documents: [...raw.documents].sort((a, b) => a.documentId.localeCompare(b.documentId)),
  };
  const rules = evaluateRules(input);
  const hasInvoice = input.documents.some((d) => d.kind === "invoice");
  const contractAbsent =
    contractRequired(input) && !input.documents.some((d) => d.kind === "contract");

  const negative = rules
    .filter((r) => r.outcome !== "pass")
    .flatMap((r) => r.reasons.filter((x) => !POSITIVE.has(x.key)));

  let flag: EvidenceFlag;
  let reasons: EvidenceReason[];
  if (!hasInvoice || contractAbsent) {
    flag = "missing";
    const absent: EvidenceReason[] = [
      ...(hasInvoice ? [] : [{ key: "noInvoice", params: {} } as const]),
      ...(contractAbsent
        ? (rules.find((r) => r.rule === "R-CONTRACT")?.reasons ?? []).filter(
            (x) => x.key === "contractMissing",
          )
        : []),
    ];
    reasons = [...absent, ...negative.filter((x) => x.key !== "contractMissing")];
  } else if (rules.some((r) => r.outcome !== "pass")) {
    flag = "weak";
    reasons = negative;
  } else {
    flag = "strong";
    reasons = [{ key: "allPassed", params: {} }];
  }

  const fact_version_ids = [...new Set(rules.flatMap((r) => r.fact_version_ids))].sort();
  const check_hash = sha256Hex(
    canonicalJson({
      flag,
      rules: rules.map((r) => [r.rule, r.outcome, r.reasons, r.fact_version_ids]),
      reasons,
    }),
  );
  return { flag, reasons, rules, fact_version_ids, check_hash };
}
