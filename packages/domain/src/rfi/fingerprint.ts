// Answer-memory fingerprint (M2-06, architecture §13). Reuse is allowed only on an exact match of this
// fingerprint: SHA-256 over the fingerprint version, the counterparty id, the answer type and the
// question text after a fixed, deterministic normalisation. No stemming, no synonyms, no fuzzy match.
// A change to the normalisation bumps FP_VERSION, so rows written under an older rule never match.
import { sha256Hex } from "../planner/sha256";

export const FP_VERSION = 1;

// Marks that carry a quantity or its unit stay: $ € % + < > = and so on (all symbols, \p{S}).
// Punctuation (\p{P}) becomes a space, except between two digits, where `.`, `,`, `:`, `/` and `-`
// are part of the figure ("1,000" and "1.000" and "1000" are three different figures; so are dates).
const APOSTROPHES = /['‘’ʼ`]/gu;
const FIGURE_JOINERS = new Set([".", ",", ":", "/", "-"]);

/** NFKC, lower case, punctuation stripped (figures kept whole), whitespace collapsed and trimmed. */
export function normalizeQuestionText(text: string): string {
  const folded = text.normalize("NFKC").toLowerCase().replace(APOSTROPHES, "");
  const chars = Array.from(folded);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (/\p{P}/u.test(c)) {
      const prev = chars[i - 1] ?? "";
      const next = chars[i + 1] ?? "";
      if (FIGURE_JOINERS.has(c) && /\p{Nd}/u.test(prev) && /\p{Nd}/u.test(next)) out += c;
      else out += " ";
    } else {
      out += c;
    }
  }
  return out.replace(/\s+/gu, " ").trim();
}

export interface FingerprintInput {
  readonly counterpartyId: string;
  readonly questionText: string;
  readonly answerType: string;
}

/** Lower-case hex SHA-256; the same input and `FP_VERSION` always give the same value. */
export function fingerprint(input: FingerprintInput): string {
  return sha256Hex(
    JSON.stringify({
      v: FP_VERSION,
      c: input.counterpartyId,
      t: input.answerType,
      q: normalizeQuestionText(input.questionText),
    }),
  );
}
