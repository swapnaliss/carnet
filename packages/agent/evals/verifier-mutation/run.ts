// Verifier mutation eval (M2-05, ADR 0010, success metric a). Takes the grounded drafts of the dataset
// (the model's recorded drafts and hand-written ones), makes each wrong in many named ways, and requires
// the verifier to reject 100% of the mutants and accept 100% of the unmutated drafts.
import { verifyAnswer } from "@carnet/domain";
import { loadDraftingCases, runDraftingEval } from "../drafting/run";
import { CURATED } from "./good-drafts";
import { type GoodDraft, MUTATION_CLASSES, type Mutant, mutantsOf } from "./mutate";

export interface MutationReport {
  mutants: number;
  rejected: number;
  escaped: { draft: string; class: string; variant: string; text: string }[];
  per_class: Record<string, { mutants: number; rejected: number }>;
  /** Why each class was rejected (reason code -> count): the rejection must be for the right reason. */
  reasons_by_class: Record<string, Record<string, number>>;
  good_total: number;
  good_accepted: number;
  good_rejected: { draft: string; reason: string | null; detail: string | null }[];
  good_by_source: Record<string, { total: number; accepted: number }>;
  good_drafts: number;
  passed: boolean;
  failures: string[];
}

export async function loadGoodDrafts(): Promise<GoodDraft[]> {
  const cases = await loadDraftingCases();
  const good: GoodDraft[] = [];
  const kept = new Map<string, Awaited<ReturnType<typeof runDraftingEval>>>();
  const keep = new Map<
    string,
    { case: (typeof cases)[number]; result: import("../../src/drafting/draft").DraftResult }
  >();
  kept.set("replay", await runDraftingEval({ mode: "replay", keep }));
  for (const [caseId, { case: c, result }] of keep) {
    for (const q of c.questions) {
      if (q.expected.status !== "ANSWER") continue;
      const r = result.results.find((x) => x.question_id === q.id);
      if (!r) continue;
      good.push({
        id: `recorded:${caseId}:${q.id}`,
        source: "recorded",
        answerType: q.answerType,
        answer: r.answer,
        facts: c.facts,
        documents: c.documents,
      });
    }
  }
  for (const d of CURATED) {
    const c = cases.find((x) => x.id === d.case);
    if (!c) throw new Error(`curated draft ${d.id}: no case ${d.case}`);
    const citations = d.cites.map(([doc, key]) => {
      const f = c.facts.find((x) => x.documentId === doc && x.key === key);
      if (!f) throw new Error(`curated draft ${d.id}: no fact ${doc}.${key}`);
      return { fact_version_id: f.id, quote: f.quote };
    });
    good.push({
      id: `curated:${d.id}`,
      source: "curated",
      answerType: d.answerType,
      answer: {
        question_id: "q",
        status: "answered",
        text: d.text,
        citations,
        document_ids: d.documents ?? [],
      },
      facts: c.facts,
      documents: c.documents,
    });
  }
  return good;
}

export async function runMutationEval(): Promise<MutationReport> {
  const good = await loadGoodDrafts();
  const perClass: MutationReport["per_class"] = Object.fromEntries(
    MUTATION_CLASSES.map((c) => [c, { mutants: 0, rejected: 0 }]),
  );
  const reasonsByClass: MutationReport["reasons_by_class"] = {};
  const escaped: MutationReport["escaped"] = [];
  const goodRejected: MutationReport["good_rejected"] = [];
  const bySource: MutationReport["good_by_source"] = {};
  let accepted = 0;
  let mutants = 0;
  let rejected = 0;
  for (const g of good) {
    const ctx = { facts: g.facts, documents: g.documents };
    const verdict = verifyAnswer(
      { id: g.answer.question_id, answerType: g.answerType },
      g.answer,
      ctx,
    );
    const slot = bySource[g.source] ?? { total: 0, accepted: 0 };
    slot.total += 1;
    if (verdict.status === "VERIFIED") {
      accepted += 1;
      slot.accepted += 1;
    } else {
      goodRejected.push({ draft: g.id, reason: verdict.reason, detail: verdict.detail });
    }
    bySource[g.source] = slot;
    for (const m of mutantsOf(g) as Mutant[]) {
      const v = verifyAnswer({ id: m.answer.question_id, answerType: m.answerType }, m.answer, ctx);
      const stat = perClass[m.class];
      if (!stat) throw new Error(`unknown class ${m.class}`);
      stat.mutants += 1;
      mutants += 1;
      if (v.status === "NEEDS_OWNER") {
        const hist = reasonsByClass[m.class] ?? {};
        hist[v.reason ?? "?"] = (hist[v.reason ?? "?"] ?? 0) + 1;
        reasonsByClass[m.class] = hist;
        stat.rejected += 1;
        rejected += 1;
      } else {
        escaped.push({ draft: g.id, class: m.class, variant: m.variant, text: m.answer.text });
      }
    }
  }
  const failures: string[] = [];
  if (mutants < 200) failures.push(`only ${mutants} mutants, need at least 200`);
  if (rejected !== mutants) failures.push(`${mutants - rejected} mutant(s) accepted`);
  if (accepted !== good.length) failures.push(`${good.length - accepted} good draft(s) rejected`);
  return {
    mutants,
    rejected,
    escaped,
    per_class: perClass,
    reasons_by_class: reasonsByClass,
    good_total: good.length,
    good_accepted: accepted,
    good_rejected: goodRejected,
    good_by_source: bySource,
    good_drafts: good.length,
    passed: failures.length === 0,
    failures,
  };
}
