// The draft verifier (M2-05, ADR 0010). Pure: no I/O, no model. The model drafts; this code decides
// whether a draft may reach the owner as "verified". Everything is checked against the facts the draft
// call was given (verified or owner-confirmed facts of the business), never against anything the
// model supplied:
//   - every citation names a supplied fact and repeats its stored quote
//   - every amount (minor units + currency), date (ISO), number and name in the text appears in the
//     cited facts; every other word is a connective word from an allowlist, or it fails closed
//   - no URL, no instruction-like content, no figure written in a form that cannot be compared
//   - an ATTACHMENT answer selects documents of the business, with facts that are usable (or of a kind
//     that has no extraction schema, such as a delivery note, where there is nothing to verify)
// Anything else becomes NEEDS_OWNER with a machine reason code and a plain-language explanation. One
// NEEDS_OWNER question makes the whole RFI NEEDS_OWNER (Airwallex respond needs every question answered).
import { extractionTypeOf } from "../evidence/fact-schemas";
import {
  findAmounts,
  findDates,
  normalizeText,
  type ParsedValue,
  scanAmounts,
  scanDates,
} from "../evidence/quote-match";

export const DRAFT_REASON_CODES = [
  "CANNOT_ANSWER",
  "ANSWER_MISSING",
  "EMPTY_ANSWER",
  "NO_CITATIONS",
  "CITATION_UNKNOWN_FACT",
  "QUOTE_MISMATCH",
  "CONFLICTING_FACTS",
  "UNSUPPORTED_AMOUNT",
  "UNSUPPORTED_DATE",
  "UNSUPPORTED_NUMBER",
  "UNSUPPORTED_NAME",
  "UNSUPPORTED_TOKEN",
  "URL_PRESENT",
  "INSTRUCTION_LIKE",
  "TEXT_TOO_LONG",
  "UNSUPPORTED_ANSWER_TYPE",
  "ATTACHMENT_NONE_SELECTED",
  "ATTACHMENT_DOCUMENT_UNKNOWN",
  "ATTACHMENT_NOT_VERIFIED",
  "MODEL_UNAVAILABLE",
  "REUSE_STALE",
] as const;
export type DraftReasonCode = (typeof DRAFT_REASON_CODES)[number];

/** What each reason means to the owner, in plain language (the UI shows these; M2-08). */
export const DRAFT_REASON_EXPLANATIONS: Record<DraftReasonCode, string> = {
  CANNOT_ANSWER: "Your documents do not contain what this question asks for.",
  ANSWER_MISSING: "No answer was drafted for this question.",
  EMPTY_ANSWER: "The drafted answer was empty.",
  NO_CITATIONS: "The answer states facts but does not point to a document that supports them.",
  CITATION_UNKNOWN_FACT: "The answer cites a fact that is not among your verified documents.",
  QUOTE_MISMATCH: "A quote in the answer does not match what the document says.",
  CONFLICTING_FACTS: "Your documents disagree with each other on a fact this answer relies on.",
  UNSUPPORTED_AMOUNT: "An amount in the answer is not in the cited documents.",
  UNSUPPORTED_DATE: "A date in the answer is not in the cited documents.",
  UNSUPPORTED_NUMBER: "A number or reference in the answer is not in the cited documents.",
  UNSUPPORTED_NAME: "A name in the answer is not in the cited documents.",
  UNSUPPORTED_TOKEN: "The answer says something the cited documents do not say.",
  URL_PRESENT: "The answer contains a web address, which is never allowed.",
  INSTRUCTION_LIKE: "The answer contains text that reads like an instruction.",
  TEXT_TOO_LONG: "The answer is too long to check.",
  UNSUPPORTED_ANSWER_TYPE: "Carnet does not answer this kind of question; you need to answer it.",
  ATTACHMENT_NONE_SELECTED: "No document was chosen to attach for this question.",
  ATTACHMENT_DOCUMENT_UNKNOWN: "The chosen attachment is not one of your documents.",
  ATTACHMENT_NOT_VERIFIED:
    "The chosen attachment has no verified or confirmed facts; confirm its facts first.",
  MODEL_UNAVAILABLE: "The drafting assistant was not available; write the answer yourself.",
  REUSE_STALE:
    "An earlier approved answer matches this question, but your documents have changed since; write or confirm the answer again.",
};

export const SUPPORTED_ANSWER_TYPES = ["TEXT", "ATTACHMENT"] as const;
export const MAX_ANSWER_CHARS = 1500;

export function isSupportedAnswerType(answerType: string): boolean {
  return (SUPPORTED_ANSWER_TYPES as readonly string[]).includes(answerType);
}

/** A fact the draft call was given. `id` is the citation handle (`<fact version id>#<index>`). */
export interface SuppliedFact {
  readonly id: string;
  readonly documentId: string;
  readonly key: string;
  readonly value: string;
  readonly parsed: ParsedValue | null;
  readonly quote: string;
  readonly page: number;
}

/** A document of the business the answer may attach. */
export interface SuppliedDocument {
  readonly id: string;
  readonly kind: string;
  /** The stored file name (untrusted data); the only description of a document without facts. */
  readonly name?: string;
  /** The latest facts version has at least one usable (verified or owner-confirmed) fact. */
  readonly hasUsableFacts: boolean;
}

export interface VerifierContext {
  readonly facts: readonly SuppliedFact[];
  readonly documents: readonly SuppliedDocument[];
}

export interface DraftCitation {
  readonly fact_version_id: string;
  readonly quote: string;
}

/** One question's answer as the model (or the owner) wrote it. */
export interface DraftAnswerInput {
  readonly question_id: string;
  readonly status: "answered" | "cannot_answer";
  readonly text: string;
  readonly citations: readonly DraftCitation[];
  readonly document_ids: readonly string[];
}

export interface VerifierQuestion {
  readonly id: string;
  readonly answerType: string;
}

export const DRAFT_ORIGINS = ["model", "owner", "system"] as const;
export const DRAFT_STATES = ["DRAFT_READY", "NEEDS_OWNER"] as const;
export const ANSWER_STATUSES = ["VERIFIED", "NEEDS_OWNER", "OWNER_AUTHORED"] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

export interface AnswerVerdict {
  readonly status: AnswerStatus;
  readonly reason: DraftReasonCode | null;
  readonly explanation: string | null;
  /** Machine-readable specifics (the token, amount or id that failed); never shown as instructions. */
  readonly detail: string | null;
}

const verified = (): AnswerVerdict => ({
  status: "VERIFIED",
  reason: null,
  explanation: null,
  detail: null,
});

export function needsOwner(reason: DraftReasonCode, detail: string | null = null): AnswerVerdict {
  return {
    status: "NEEDS_OWNER",
    reason,
    explanation: DRAFT_REASON_EXPLANATIONS[reason],
    detail: detail === null ? null : detail.slice(0, 200),
  };
}

// ---------------------------------------------------------------------------------------------
// Words the text may use without a supporting fact: connectives and generic payment vocabulary. None
// of them can carry a name, a number or a date. Everything else must occur in a cited fact.

const CONNECTIVE_WORDS = `
a an the and or but nor of in on at by for with without from to into onto over under per via as than
that this these those it its their there here is are was were be been being has have had having do
does did will would shall should can could may might not no also which who whom whose when where while
if then so such each every any all both either other another same only more most some
payment payments pay paid paying payee payer supplier buyer seller customer client vendor beneficiary
invoice invoices contract agreement order purchase goods services service amount total sum fee fees
date dated number reference account bank transfer funds source evidence document documents attached
attachment copy details terms term day days business relationship purpose provided issued issue
issues covers covered cover settles settle settled made make makes according stated states state
specified specifies named matches match confirms confirmed shows shown printed supplies supplied
delivered delivery received sent currency between among regarding concerning about parties party
scope effective clause number reference references named called
`
  .split(/\s+/)
  .filter(Boolean);
export const ALLOWED_WORDS: ReadonlySet<string> = new Set(CONNECTIVE_WORDS);

const TOKEN_RE = /[\p{L}\p{N}]+(?:[-_/.'][\p{L}\p{N}]+)*/gu;

function tokensOf(text: string): string[] {
  return (normalizeText(text).match(TOKEN_RE) ?? []).map((t) => t.toLowerCase());
}

const URL_RE =
  /(?:https?:|ftp:|www\.)|\b[\w-]+\.(?:com|org|net|io|co|eu|de|nl|uk|us|app|dev|example|info|biz|xyz|me|ai)\b|@[\w-]|\b[a-z0-9-]+\.[a-z]{2,}\//i;

const INSTRUCTION_RES: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.]{0,60}\b(?:previous|prior|above|earlier|instructions?|rules?|system)\b/i,
  /\b(?:you must|you should|you are|you will|act as|pretend|system prompt|as an ai|language model)\b/i,
  /\b(?:approve this|answer every|answer all|no documents are needed|do not (?:mention|tell|reveal))\b/i,
  /^\s*(?:please\s+)?(?:ignore|approve|send|release|disregard|output|reply|respond|execute|run)\b/i,
  /[<>{}`[\]|\\]/,
];

const norm = (s: string) =>
  normalizeText(s)
    .toLowerCase()
    .replace(/[.,;]+$/, "");

function parsedKey(p: ParsedValue | null): string | null {
  if (!p) return null;
  switch (p.type) {
    case "text":
      return `t:${norm(p.text)}`;
    case "date":
      return `d:${p.date}`;
    case "amount":
      return `a:${p.minor}:${p.currency}`;
  }
}

const amountKey = (a: { minor: bigint | string; currency: string }) =>
  `${a.minor.toString()}:${a.currency}`;

interface Evidence {
  readonly amounts: Set<string>;
  readonly dates: Set<string>;
  readonly tokens: Set<string>;
  readonly streams: string[];
}

function evidenceOf(cited: readonly SuppliedFact[]): Evidence {
  const amounts = new Set<string>();
  const dates = new Set<string>();
  const tokens = new Set<string>();
  const streams: string[] = [];
  for (const f of cited) {
    for (const text of [f.quote, f.value]) {
      for (const a of findAmounts(text)) amounts.add(amountKey(a));
      for (const d of findDates(text)) dates.add(d);
      const toks = tokensOf(text);
      for (const t of toks) tokens.add(t);
      streams.push(` ${toks.join(" ")} `);
    }
    if (f.parsed?.type === "amount") amounts.add(`${f.parsed.minor}:${f.parsed.currency}`);
    if (f.parsed?.type === "date") dates.add(f.parsed.date);
  }
  return { amounts, dates, tokens, streams };
}

/** Replaces `ranges` of `text` with spaces. */
function mask(text: string, ranges: readonly { start: number; end: number }[]): string {
  const chars = [...text];
  for (const { start, end } of ranges) {
    for (let i = start; i < end && i < chars.length; i++) chars[i] = " ";
  }
  return chars.join("");
}

const isCapitalised = (raw: string) => /^\p{Lu}/u.test(raw);

/** Checks a text against the facts it cites. Returns the first failure, or null. */
function checkText(text: string, cited: readonly SuppliedFact[]): AnswerVerdict | null {
  const normalised = normalizeText(text);
  if (normalised.length === 0) return needsOwner("EMPTY_ANSWER");
  if (text.length > MAX_ANSWER_CHARS) return needsOwner("TEXT_TOO_LONG", `${text.length} chars`);
  if (URL_RE.test(normalised)) return needsOwner("URL_PRESENT");
  if (INSTRUCTION_RES.some((re) => re.test(normalised))) return needsOwner("INSTRUCTION_LIKE");

  // Cited facts may not disagree with each other on the same key (for example two different totals).
  const seen = new Map<string, string>();
  for (const f of cited) {
    const k = parsedKey(f.parsed);
    if (k === null) continue;
    const prior = seen.get(f.key);
    if (prior !== undefined && prior !== k) return needsOwner("CONFLICTING_FACTS", f.key);
    seen.set(f.key, k);
  }

  const ev = evidenceOf(cited);
  const amounts = scanAmounts(normalised);
  for (const a of amounts) {
    if (!ev.amounts.has(amountKey(a))) {
      return needsOwner("UNSUPPORTED_AMOUNT", `${a.currency} ${a.minor.toString()} minor`);
    }
  }
  const dates = scanDates(normalised);
  for (const d of dates) {
    if (!ev.dates.has(d.iso)) return needsOwner("UNSUPPORTED_DATE", d.iso);
  }

  const rest = mask(normalised, [...amounts, ...dates]);
  const rawTokens = rest.match(TOKEN_RE) ?? [];
  let run: string[] = [];
  const flushRun = (): AnswerVerdict | null => {
    if (run.length >= 2) {
      const phrase = ` ${run.join(" ")} `;
      if (!ev.streams.some((s) => s.includes(phrase))) {
        return needsOwner("UNSUPPORTED_NAME", run.join(" "));
      }
    }
    run = [];
    return null;
  };
  for (const raw of rawTokens) {
    const token = raw.toLowerCase();
    const allowed = ALLOWED_WORDS.has(token);
    const inEvidence = ev.tokens.has(token);
    if (/\d/.test(token)) {
      if (!inEvidence) return needsOwner("UNSUPPORTED_NUMBER", raw);
    } else if (!allowed && !inEvidence) {
      return needsOwner(isCapitalised(raw) ? "UNSUPPORTED_NAME" : "UNSUPPORTED_TOKEN", raw);
    }
    if (isCapitalised(raw) && !allowed && !/\d/.test(raw)) {
      run.push(token);
    } else {
      const failed = flushRun();
      if (failed) return failed;
    }
  }
  return flushRun();
}

/**
 * Documents whose facts disagree with another document about the same purchase order: an invoice and the
 * purchase order it names that show different totals (the dataset's "contradict" case). An answer that
 * cites a fact of such a document is NEEDS_OWNER until the owner resolves the difference (a corrected
 * facts version replaces the disputed fact). Only this one comparison is made, because a payment's
 * documents are not linked to it yet (M2-03); comparing unrelated documents would block every answer.
 */
export function findDisputedDocuments(facts: readonly SuppliedFact[]): Set<string> {
  const byPo = new Map<string, Map<string, string>>(); // PO number -> document id -> total key
  const poOf = new Map<string, string>(); // document id -> PO number
  for (const f of facts) {
    if (f.key === "purchase_order" && f.parsed?.type === "text")
      poOf.set(f.documentId, norm(f.parsed.text));
  }
  for (const f of facts) {
    const po = poOf.get(f.documentId);
    const total = f.key === "total" ? parsedKey(f.parsed) : null;
    if (!po || total === null) continue;
    const docs = byPo.get(po) ?? new Map<string, string>();
    docs.set(f.documentId, total);
    byPo.set(po, docs);
  }
  const disputed = new Set<string>();
  for (const docs of byPo.values()) {
    if (new Set(docs.values()).size > 1) for (const id of docs.keys()) disputed.add(id);
  }
  return disputed;
}

/**
 * Verifies one answer. `ownerAuthored` marks text the owner wrote without citations; it is accepted as
 * `OWNER_AUTHORED` (the UI shows it as unverified). Owner text that cites facts goes through the same
 * checks as a model draft.
 */
export function verifyAnswer(
  question: VerifierQuestion,
  answer: DraftAnswerInput,
  ctx: VerifierContext,
  options: { ownerAuthored?: boolean } = {},
): AnswerVerdict {
  if (!isSupportedAnswerType(question.answerType)) {
    return needsOwner("UNSUPPORTED_ANSWER_TYPE", question.answerType);
  }
  const isAttachment = question.answerType === "ATTACHMENT";
  const owner = options.ownerAuthored === true;
  if (answer.status === "cannot_answer" && !owner) return needsOwner("CANNOT_ANSWER");

  if (isAttachment) {
    const ids = [...new Set(answer.document_ids)];
    if (ids.length === 0) return needsOwner("ATTACHMENT_NONE_SELECTED");
    const byId = new Map(ctx.documents.map((d) => [d.id, d]));
    for (const id of ids) {
      const doc = byId.get(id);
      if (!doc) return needsOwner("ATTACHMENT_DOCUMENT_UNKNOWN", id);
      if (extractionTypeOf(doc.kind) !== null && !doc.hasUsableFacts) {
        return needsOwner("ATTACHMENT_NOT_VERIFIED", id);
      }
    }
    if (normalizeText(answer.text).length === 0 && answer.citations.length === 0) return verified();
  } else if (normalizeText(answer.text).length === 0) {
    return needsOwner("EMPTY_ANSWER");
  }

  if (answer.citations.length === 0) {
    if (owner) {
      if (answer.text.length > MAX_ANSWER_CHARS) {
        return needsOwner("TEXT_TOO_LONG", `${answer.text.length} chars`);
      }
      return { status: "OWNER_AUTHORED", reason: null, explanation: null, detail: null };
    }
    return needsOwner("NO_CITATIONS");
  }
  const byFact = new Map(ctx.facts.map((f) => [f.id, f]));
  const cited: SuppliedFact[] = [];
  for (const c of answer.citations) {
    const fact = byFact.get(c.fact_version_id);
    if (!fact) return needsOwner("CITATION_UNKNOWN_FACT", c.fact_version_id);
    if (normalizeText(c.quote) !== normalizeText(fact.quote)) {
      return needsOwner("QUOTE_MISMATCH", c.fact_version_id);
    }
    cited.push(fact);
  }
  const disputed = findDisputedDocuments(ctx.facts);
  const hit = cited.find((f) => disputed.has(f.documentId));
  if (hit) return needsOwner("CONFLICTING_FACTS", `document ${hit.documentId}`);
  return checkText(answer.text, cited) ?? verified();
}

export interface DraftVerification {
  readonly question_id: string;
  readonly answer: DraftAnswerInput;
  readonly verdict: AnswerVerdict;
}

/** An answer for every question, in the questions' order; a missing one is NEEDS_OWNER. */
export function verifyDraft(
  questions: readonly VerifierQuestion[],
  answers: readonly DraftAnswerInput[],
  ctx: VerifierContext,
): DraftVerification[] {
  return questions.map((q) => {
    const answer = answers.find((a) => a.question_id === q.id);
    if (!answer) {
      return {
        question_id: q.id,
        answer: {
          question_id: q.id,
          status: "cannot_answer",
          text: "",
          citations: [],
          document_ids: [],
        },
        verdict: isSupportedAnswerType(q.answerType)
          ? needsOwner("ANSWER_MISSING")
          : needsOwner("UNSUPPORTED_ANSWER_TYPE", q.answerType),
      };
    }
    return { question_id: q.id, answer, verdict: verifyAnswer(q, answer, ctx) };
  });
}

export interface BlockingQuestion {
  readonly question_id: string;
  readonly reason: DraftReasonCode;
  readonly explanation: string;
}

export interface DraftRollup {
  readonly state: "DRAFT_READY" | "NEEDS_OWNER";
  readonly blocking: readonly BlockingQuestion[];
}

/** All-or-nothing (Airwallex respond needs every question answered): one NEEDS_OWNER blocks the RFI. */
export function rollupDraft(
  results: readonly { question_id: string; verdict: AnswerVerdict }[],
): DraftRollup {
  const blocking: BlockingQuestion[] = [];
  for (const r of results) {
    if (r.verdict.status === "NEEDS_OWNER" && r.verdict.reason) {
      blocking.push({
        question_id: r.question_id,
        reason: r.verdict.reason,
        explanation: r.verdict.explanation ?? DRAFT_REASON_EXPLANATIONS[r.verdict.reason],
      });
    }
  }
  return {
    state: blocking.length === 0 && results.length > 0 ? "DRAFT_READY" : "NEEDS_OWNER",
    blocking,
  };
}
