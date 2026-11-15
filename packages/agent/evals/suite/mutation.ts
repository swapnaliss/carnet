// Mutation set (M4-03, ADR 0010). Every good draft (the model's recorded drafts and the hand-written
// ones, M2-05) is made wrong in two ways: the named, exhaustive mutators of M2-05 (`mutantsOf`) and a
// seeded generator for the classes the ticket names (one digit off, order of magnitude, swapped date
// parts, look-alike counterparty names, currency swaps). The seed is fixed, so the set is the same on
// every run. The verifier is code, so the set runs without a model call on every build.
//
// `EVAL_WEAKEN_VERIFIER=1` (test only, never read by the product) accepts answers the verifier rejected
// for an unsupported amount, so the suite can prove that a weaker verifier fails it and names the survivor.
import {
  type DraftAnswerInput,
  normalizeText,
  scanAmounts,
  scanDates,
  verifyAnswer,
} from "@carnet/domain";
import { type GoodDraft, MUTATION_CLASSES, mutantsOf } from "../verifier-mutation/mutate";
import { loadGoodDrafts } from "../verifier-mutation/run";

export const DEFAULT_SEED = 20261115;
export const SEEDED_CLASSES = [
  "digit_off_by_one",
  "order_of_magnitude",
  "swapped_date_parts",
  "lookalike_name",
  "currency_swap",
] as const;
export const ALL_CLASSES = [...MUTATION_CLASSES, ...SEEDED_CLASSES] as const;

/** mulberry32: a small deterministic PRNG, so the mutant set is reproducible from its seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeededMutant {
  readonly class: string;
  readonly variant: string;
  readonly answerType: string;
  readonly answer: DraftAnswerInput;
}

const LOOKALIKE: Record<string, string> = {
  o: "0",
  O: "0",
  l: "1",
  I: "l",
  i: "í",
  e: "é",
  a: "á",
  m: "rn",
  n: "r",
  S: "5",
  B: "8",
};
const CURRENCIES = ["USD", "EUR", "GBP", "CHF", "AUD", "SGD", "HKD", "JPY"];

const pick = <T>(rand: () => number, xs: readonly T[]): T =>
  xs[Math.floor(rand() * xs.length)] as T;

/** Seeded mutants of one good draft (TEXT answers only: attachments have no figures to change). */
export function seededMutantsOf(good: GoodDraft, rand: () => number): SeededMutant[] {
  const out: SeededMutant[] = [];
  const a = good.answer;
  if (good.answerType !== "TEXT" || a.text.length === 0) return out;
  const text = normalizeText(a.text);
  const at = (start: number, end: number, repl: string) =>
    `${text.slice(0, start)}${repl}${text.slice(end)}`;
  const push = (cls: string, variant: string, t: string) => {
    if (normalizeText(t).toLowerCase() === text.toLowerCase()) return;
    out.push({ class: cls, variant, answerType: good.answerType, answer: { ...a, text: t } });
  };

  for (const [i, sp] of scanAmounts(text).entries()) {
    const raw = text.slice(sp.start, sp.end);
    const digits = [...raw].map((c, j) => (/\d/.test(c) ? j : -1)).filter((j) => j >= 0);
    if (digits.length > 0) {
      const j = pick(rand, digits);
      const d = Number(raw[j]);
      const nd = (d + 1 + Math.floor(rand() * 8)) % 10;
      push(
        "digit_off_by_one",
        `amount#${i}:pos${j}:${d}->${nd}`,
        at(sp.start, sp.end, raw.slice(0, j) + String(nd) + raw.slice(j + 1)),
      );
    }
    const up = rand() < 0.5;
    const minor = up ? sp.minor * 10n : sp.minor / 10n;
    const s = minor.toString().padStart(3, "0");
    const major = `${s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${s.slice(-2)}`;
    push(
      "order_of_magnitude",
      `amount#${i}:${up ? "x10" : "/10"}`,
      at(sp.start, sp.end, `${sp.currency} ${major}`),
    );
    const other = pick(
      rand,
      CURRENCIES.filter((c) => c !== sp.currency),
    );
    push(
      "currency_swap",
      `amount#${i}:${sp.currency}->${other}`,
      at(sp.start, sp.end, raw.replace(sp.currency, other).replace(/[$€£]/, `${other} `)),
    );
  }

  for (const [i, sp] of scanDates(text).entries()) {
    const [y, m, d] = sp.iso.split("-");
    if (!y || !m || !d) continue;
    // Day and month swapped (when that is still a date and a different one), or the year's last two
    // digits transposed: the mistakes a person makes copying a date.
    if (Number(d) <= 12 && d !== m) {
      push("swapped_date_parts", `date#${i}:day<->month`, at(sp.start, sp.end, `${y}-${d}-${m}`));
    }
    const ty = `${y.slice(0, 2)}${y[3]}${y[2]}`;
    if (ty !== y)
      push("swapped_date_parts", `date#${i}:year_digits`, at(sp.start, sp.end, `${ty}-${m}-${d}`));
  }

  // Look-alike counterparty names: one character of a capitalised name word replaced by a similar glyph.
  const words = [...text.matchAll(/\b[A-Z][a-z]{3,}\b/g)];
  const cited = good.facts
    .filter((f) => a.citations.some((c) => c.fact_version_id === f.id))
    .map((f) => `${f.quote} ${f.value}`)
    .join(" ");
  const names = words.filter((w) => cited.includes(w[0]));
  for (let n = 0; n < Math.min(2, names.length); n++) {
    const w = pick(rand, names);
    const word = w[0];
    const positions = [...word].map((c, j) => (LOOKALIKE[c] ? j : -1)).filter((j) => j >= 0);
    if (positions.length === 0) continue;
    const j = pick(rand, positions);
    const ch = word[j] as string;
    const repl = `${word.slice(0, j)}${LOOKALIKE[ch]}${word.slice(j + 1)}`;
    const start = w.index ?? 0;
    push("lookalike_name", `${word}->${repl}`, at(start, start + word.length, repl));
  }
  return out;
}

export interface MutationResult {
  readonly seed: number;
  readonly weakened: boolean;
  readonly good_drafts: number;
  readonly good_accepted: number;
  readonly mutants: number;
  readonly rejected: number;
  readonly per_class: Record<string, { mutants: number; rejected: number }>;
  readonly survivors: { draft: string; class: string; variant: string; text: string }[];
  readonly good_rejected: { draft: string; reason: string | null }[];
}

/** The weakened verifier: accepts what the real one rejected for an unsupported amount. Test only. */
function verdictOf(
  weakened: boolean,
  ...args: Parameters<typeof verifyAnswer>
): "VERIFIED" | "NEEDS_OWNER" | "OWNER_AUTHORED" {
  const v = verifyAnswer(...args);
  if (weakened && v.status === "NEEDS_OWNER" && v.reason === "UNSUPPORTED_AMOUNT")
    return "VERIFIED";
  return v.status;
}

export async function runMutationSet(options: {
  seed?: number;
  weakened?: boolean;
}): Promise<MutationResult> {
  const seed = options.seed ?? DEFAULT_SEED;
  const weakened = options.weakened ?? false;
  const rand = prng(seed);
  const good = await loadGoodDrafts();
  const perClass: Record<string, { mutants: number; rejected: number }> = Object.fromEntries(
    ALL_CLASSES.map((c) => [c, { mutants: 0, rejected: 0 }]),
  );
  const survivors: MutationResult["survivors"] = [];
  const goodRejected: MutationResult["good_rejected"] = [];
  let accepted = 0;
  let mutants = 0;
  let rejected = 0;
  for (const g of good) {
    const ctx = { facts: g.facts, documents: g.documents };
    const v = verifyAnswer({ id: g.answer.question_id, answerType: g.answerType }, g.answer, ctx);
    if (v.status === "VERIFIED") accepted += 1;
    else goodRejected.push({ draft: g.id, reason: v.reason });
    for (const m of [...mutantsOf(g), ...seededMutantsOf(g, rand)]) {
      const status = verdictOf(
        weakened,
        { id: m.answer.question_id, answerType: m.answerType },
        m.answer,
        ctx,
      );
      const slot = perClass[m.class] ?? { mutants: 0, rejected: 0 };
      slot.mutants += 1;
      mutants += 1;
      if (status === "NEEDS_OWNER") {
        slot.rejected += 1;
        rejected += 1;
      } else {
        survivors.push({ draft: g.id, class: m.class, variant: m.variant, text: m.answer.text });
      }
      perClass[m.class] = slot;
    }
  }
  return {
    seed,
    weakened,
    good_drafts: good.length,
    good_accepted: accepted,
    mutants,
    rejected,
    per_class: perClass,
    survivors,
    good_rejected: goodRejected,
  };
}
