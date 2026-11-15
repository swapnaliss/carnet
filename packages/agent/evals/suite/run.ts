// The M4-03 eval suite: one command, one results file.
//
//   npm run eval -- --mode replay [--out file]          recorded model replies, no network, $0
//   npm run eval -- --mode live [--limit n] [--out f]   real model calls through the harness, capped by
//                                                       EVAL_SPEND_CAP_USD (default 1.00)
//
// Order (Scope 5): deterministic code assertions first (ground truth, mutation set, adversarial set,
// trajectory), then, in live mode only, the LLM judge on wording, which can only add a failure.
// The process exits 0 only when every threshold holds.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type DraftVerification, verifyDraft } from "@carnet/domain";
import type { DraftResult } from "../../src/drafting/draft";
import { VERSION as DRAFT_VERSION } from "../../src/drafting/prompts/draft";
import { createHarness, EXTRACTION_PROMPTS, type ExtractionResult } from "../../src/index";
import { type MemoryStore, memoryStore, USD } from "../../test/memory-store";
import {
  type DraftingCase,
  type DraftingReport,
  loadDraftingCases,
  type QuestionReport,
  runDraftingEval,
} from "../drafting/run";
import { type EvalReport, loadCases, matchesGroundTruth, runEval } from "../extraction/run";
import { loadGoodDrafts } from "../verifier-mutation/run";
import { ADVERSARIAL_CATEGORIES, runAdversarial } from "./adversarial";
import {
  combineVerdict,
  JUDGE_MODEL,
  JUDGE_VERSION,
  type JudgeScore,
  judgeAnswer,
  PASS,
  RUBRIC_VERSION,
  rubricSha,
} from "./judge";
import { DEFAULT_SEED, type MutationResult, runMutationSet } from "./mutation";
import { type CaseOutcome, fail, pass } from "./support";
import { recoveryChecks, storedStepChecks } from "./trajectory";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const EVIDENCE_PATH = `${ROOT}docs/evidence/evals.md`;
export const MIN_CASES = 40;
export const MIN_PER_CATEGORY = 8;
export const MIN_MUTANTS = 100;
export const MIN_ADVERSARIAL_PER_CATEGORY = 3;
export const GROUNDING_THRESHOLD = 0.95;
export const DEFAULT_CAP_USD = 1.0;

export class SpendCapError extends Error {
  constructor(capUsd: number, spentUsd: number) {
    super(
      `EVAL_SPEND_CAP_USD=${capUsd} would be exceeded (spent USD ${spentUsd.toFixed(6)} so far; the next call's worst case is over the cap): live run aborted, no further model calls`,
    );
    this.name = "SpendCapError";
  }
}

export interface SuiteOptions {
  readonly mode: "replay" | "live";
  readonly limit?: number;
  readonly weakenVerifier?: boolean;
  readonly capUsd?: number;
  readonly seed?: number;
}

export interface SuiteReport {
  date: string;
  commit: string;
  mode: "replay" | "live";
  limit: number | null;
  models: { extraction: string; drafting: string; judge: string };
  prompt_versions: Record<string, string>;
  rubric: { version: string; sha: string; path: string };
  ground_truth: { extraction: CaseOutcome[]; drafting: CaseOutcome[]; verifier: CaseOutcome[] };
  extraction: EvalReport;
  drafting: DraftingReport;
  m2_run: { answerable: number; grounded: number; outcomes: CaseOutcome[] };
  grounding: { answerable: number; grounded: number; rate: number };
  mutation: MutationResult;
  adversarial: CaseOutcome[];
  trajectory: CaseOutcome[];
  judge: {
    ran: boolean;
    judged: number;
    passed: number;
    share: number | null;
    scores: { case: string; question: string; score: JudgeScore | null; final: string }[];
  };
  /** Spend of this run (0 in replay) and, for replay, what the recorded replies cost when they were made. */
  cost: { total_usd: number; calls: number; cap_usd: number | null; recorded_usd: number };
  thresholds: string[];
  failures: string[];
  passed: boolean;
}

const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: ROOT })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/** Extraction ground truth: every field right and its quote verified (text), or nothing auto-grounded (image). */
function extractionCases(
  results: ReadonlyMap<string, ExtractionResult>,
  limit?: number,
): CaseOutcome[] {
  return loadCases()
    .slice(0, limit ?? Number.POSITIVE_INFINITY)
    .map((c) => {
      const r = results.get(c.id);
      const id = `extract ${c.id}`;
      if (!r) return fail(id, "extraction", "no result");
      if (!c.textLayer) {
        const facts = r.status === "EXTRACTED" ? r.facts : [];
        const auto = facts.filter((f) => f.quote_verified || !f.needs_confirmation);
        return auto.length === 0
          ? pass(
              id,
              "extraction",
              `image-only: ${facts.length} fact(s), all need owner confirmation`,
            )
          : fail(id, "extraction", `image-only: ${auto.length} fact(s) auto-grounded`);
      }
      if (r.status !== "EXTRACTED") return fail(id, "extraction", `status ${r.status}`);
      const wrong = c.facts.filter(
        (g) =>
          !r.facts.some(
            (f) => f.key === g.field && f.quote_verified && matchesGroundTruth(g.value, f),
          ),
      );
      return wrong.length === 0
        ? pass(
            id,
            "extraction",
            `${c.facts.length} field(s) right, quotes verified on the text layer`,
          )
        : fail(id, "extraction", `wrong or unverified: ${wrong.map((g) => g.field).join(", ")}`);
    });
}

function draftingCases(results: readonly QuestionReport[]): CaseOutcome[] {
  return results.map((q) => {
    const want = q.expected === "ANSWER" ? "VERIFIED" : "NEEDS_OWNER";
    const id = `draft ${q.case}/${q.question}`;
    return q.verdict === want
      ? pass(id, "drafting", `${q.expected} -> ${q.verdict}`)
      : fail(id, "drafting", `expected ${want}, got ${q.verdict} (${q.reason ?? ""})`);
  });
}

interface M2Recording {
  id_map: {
    questions: Record<string, string>;
    fact_versions: Record<string, string>;
    documents: Record<string, string>;
  };
  calls: { response: { content: { type: string; text?: string }[] } }[];
}

/**
 * M2's recorded live run (fixtures/anthropic/m2-run/, M2-09): the model's real draft for the harbor RFI,
 * mapped from the live database's ids to the dataset's, re-verified against today's facts of the case.
 * Citations are re-bound by document and quote (the live database numbered facts its own way).
 */
function m2RunCase(cases: readonly DraftingCase[]): SuiteReport["m2_run"] {
  const rec = JSON.parse(
    readFileSync(`${ROOT}fixtures/anthropic/m2-run/drafting/rfi-set-harbor-m2-run-r1.json`, "utf8"),
  ) as M2Recording;
  const c = cases.find((x) => x.id === "rfi-set-harbor-r1");
  const text = rec.calls.at(-1)?.response.content.find((b) => b.type === "text")?.text;
  if (!c || !text)
    return { answerable: 0, grounded: 0, outcomes: [fail("m2-run", "drafting", "missing")] };
  const parsed = JSON.parse(text) as {
    answers: {
      question_id: string;
      status: "answered" | "cannot_answer";
      text: string;
      citations: { fact_version_id: string; quote: string }[];
      document_ids: string[];
    }[];
  };
  const answers = parsed.answers.map((a) => ({
    ...a,
    question_id: rec.id_map.questions[a.question_id] ?? a.question_id,
    document_ids: a.document_ids.map((d) => rec.id_map.documents[d] ?? d),
    citations: a.citations.map((cit) => {
      const [fv] = cit.fact_version_id.split("#");
      const doc = rec.id_map.fact_versions[fv ?? ""];
      const fact = c.facts.find((f) => f.documentId === doc && f.quote === cit.quote);
      return { fact_version_id: fact?.id ?? cit.fact_version_id, quote: cit.quote };
    }),
  }));
  const results: DraftVerification[] = verifyDraft(c.questions, answers, c);
  const outcomes = c.questions.map((q) => {
    const r = results.find((x) => x.question_id === q.id);
    const want = q.expected.status === "ANSWER" ? "VERIFIED" : "NEEDS_OWNER";
    const id = `draft m2-run/${q.id}`;
    return r?.verdict.status === want
      ? pass(id, "drafting", `M2-09 live reply: ${q.expected.status} -> ${r.verdict.status}`)
      : fail(
          id,
          "drafting",
          `M2-09 live reply: expected ${want}, got ${r?.verdict.status} (${r?.verdict.reason ?? ""}: ${r?.verdict.detail ?? ""})`,
        );
  });
  const answerable = c.questions.filter((q) => q.expected.status === "ANSWER");
  return {
    answerable: answerable.length,
    grounded: answerable.filter(
      (q) => results.find((x) => x.question_id === q.id)?.verdict.status === "VERIFIED",
    ).length,
    outcomes,
  };
}

export async function runSuite(options: SuiteOptions): Promise<SuiteReport> {
  process.env.ANTHROPIC_API_KEY ||= options.mode === "replay" ? "replay-only-not-a-key" : "";
  const live = options.mode === "live";
  const capUsd = options.capUsd ?? DEFAULT_CAP_USD;
  const capNano = Math.round(capUsd * USD);
  const stores: MemoryStore[] = [];
  const spent = () =>
    stores.reduce((a, s) => a + s.steps.reduce((b, x) => b + x.costNanoUsd, 0), 0);
  // One cap over the whole run: each case's store starts with what the run already spent, so the
  // harness's daily-cap check (M4-02 spend guard, before every call) refuses a call that would cross it.
  const storeFactory = () => {
    if (live && stores.some((s) => s.steps.some((x) => x.outcome === "spend_cap"))) {
      throw new SpendCapError(capUsd, spent() / USD);
    }
    const s = memoryStore({
      agentsEnabled: true,
      perRunCapNanoUsd: capNano,
      dailyCapNanoUsd: capNano,
    });
    s.otherSpendToday = spent();
    stores.push(s);
    return s;
  };
  const assertUnderCap = () => {
    if (live && stores.some((s) => s.steps.some((x) => x.outcome === "spend_cap"))) {
      throw new SpendCapError(capUsd, spent() / USD);
    }
  };

  const limit = options.limit;
  const exResults = new Map<string, ExtractionResult>();
  const extraction = await runEval({
    mode: options.mode,
    keep: exResults,
    storeFactory,
    record: false,
    ...(limit ? { limit } : {}),
  });
  assertUnderCap();
  const drafting = await runDraftingEval({
    mode: options.mode,
    storeFactory,
    record: false,
    ...(limit ? { limit } : {}),
  });
  assertUnderCap();

  // Everything below is code over recorded replies: free, and the same in both modes.
  const cases = await loadDraftingCases();
  const replayDrafts = new Map<string, { case: DraftingCase; result: DraftResult }>();
  const replayEx = new Map<string, ExtractionResult>();
  if (live) {
    await runDraftingEval({ mode: "replay", keep: replayDrafts });
    await runEval({ mode: "replay", keep: replayEx });
  } else {
    await runDraftingEval({ mode: "replay", keep: replayDrafts });
    for (const [k, v] of exResults) replayEx.set(k, v);
  }
  const m2 = m2RunCase(cases);
  const good = await loadGoodDrafts();
  const verifierCases = good.map((g) => {
    const r = verifyDraft([{ id: g.answer.question_id, answerType: g.answerType }], [g.answer], g);
    const v = r[0]?.verdict;
    return v?.status === "VERIFIED"
      ? pass(`verify good ${g.id}`, "verifier", "grounded draft accepted")
      : fail(`verify good ${g.id}`, "verifier", `rejected: ${v?.reason} ${v?.detail ?? ""}`);
  });
  const mutation = await runMutationSet({
    seed: options.seed ?? DEFAULT_SEED,
    weakened: options.weakenVerifier ?? false,
  });
  const adversarial = await runAdversarial({ cases, drafts: replayDrafts, extraction: replayEx });
  const trajectory = [
    ...storedStepChecks(stores, drafting.results),
    ...(await recoveryChecks(cases)),
  ];

  // The judge (live only): VERIFIED text answers, after the code assertions.
  const judge: SuiteReport["judge"] = { ran: false, judged: 0, passed: 0, share: null, scores: [] };
  if (live) {
    judge.ran = true;
    const store = storeFactory();
    const harness = createHarness({ store });
    const run = await harness.startRun({ kind: "eval-judge", ref: new Date().toISOString() });
    for (const q of drafting.results) {
      if (q.answer_type !== "TEXT" || q.text.trim() === "") continue;
      const dc = cases.find((c) => c.id === q.case)?.questions.find((x) => x.id === q.question);
      const codePassed = q.verdict === (q.expected === "ANSWER" ? "VERIFIED" : "NEEDS_OWNER");
      const score =
        q.verdict === "VERIFIED" && dc
          ? await judgeAnswer({
              harness,
              run,
              step: `judge:${q.case}:${q.question}`,
              question: { title: dc.title, description: dc.description },
              answerText: q.text,
            })
          : null;
      assertUnderCap();
      const final = combineVerdict(codePassed, score);
      if (score) {
        judge.judged += 1;
        if (final.passed) judge.passed += 1;
      }
      judge.scores.push({
        case: q.case,
        question: q.question,
        score,
        final: final.passed ? "pass" : `fail (${final.by})`,
      });
    }
    await harness.finishRun(run, "DONE");
    judge.share = judge.judged === 0 ? null : judge.passed / judge.judged;
  }

  const gt = {
    extraction: extractionCases(exResults, limit),
    drafting: [...draftingCases(drafting.results), ...m2.outcomes],
    verifier: verifierCases,
  };
  const answerable = drafting.answerable + m2.answerable;
  const grounded = drafting.grounded + m2.grounded;
  const groundingRate = answerable === 0 ? 0 : grounded / answerable;
  const total = gt.extraction.length + gt.drafting.length + gt.verifier.length;

  const thresholds: string[] = [];
  const failures: string[] = [];
  const check = (name: string, ok: boolean, why: string) => {
    thresholds.push(`${ok ? "PASS" : "FAIL"} ${name}`);
    if (!ok) failures.push(`${name}: ${why}`);
  };
  if (!limit) {
    check(`ground-truth cases >= ${MIN_CASES}`, total >= MIN_CASES, `${total}`);
    for (const [k, v] of Object.entries(gt)) {
      check(`${k} cases >= ${MIN_PER_CATEGORY}`, v.length >= MIN_PER_CATEGORY, `${v.length}`);
    }
  }
  check(
    `grounding rate >= ${pct(GROUNDING_THRESHOLD)}`,
    groundingRate >= GROUNDING_THRESHOLD,
    pct(groundingRate),
  );
  check(
    "unanswerable questions all NEEDS_OWNER",
    gt.drafting.filter((c) => /expected NEEDS_OWNER/.test(c.detail)).length === 0,
    "an unanswerable question was answered",
  );
  check(
    "extraction thresholds (M2-02: accuracy, quote verification, no wrong-but-verified)",
    extraction.passed,
    extraction.failures.join("; "),
  );
  check("drafting thresholds (M2-05)", drafting.passed, drafting.failures.join("; "));
  check(
    "every grounded good draft accepted by the verifier",
    verifierCases.every((c) => c.passed),
    verifierCases
      .filter((c) => !c.passed)
      .map((c) => c.id)
      .join("; "),
  );
  check(`mutants >= ${MIN_MUTANTS}`, mutation.mutants >= MIN_MUTANTS, `${mutation.mutants}`);
  check(
    "mutation rejection 100%",
    mutation.rejected === mutation.mutants,
    `${mutation.survivors.length} survivor(s): ${mutation.survivors
      .slice(0, 10)
      .map((s) => `[${s.class} ${s.variant}] ${s.draft}: "${s.text}"`)
      .join(" | ")}`,
  );
  for (const cat of ADVERSARIAL_CATEGORIES) {
    const n = adversarial.filter((c) => c.category === cat).length;
    check(
      `adversarial ${cat} >= ${MIN_ADVERSARIAL_PER_CATEGORY} cases`,
      n >= MIN_ADVERSARIAL_PER_CATEGORY,
      `${n}`,
    );
  }
  check(
    "every adversarial case safe",
    adversarial.every((c) => c.passed),
    adversarial
      .filter((c) => !c.passed)
      .map((c) => `${c.id}: ${c.detail}`)
      .join("; "),
  );
  check(
    "every trajectory check",
    trajectory.every((c) => c.passed),
    trajectory
      .filter((c) => !c.passed)
      .map((c) => `${c.id}: ${c.detail}`)
      .join("; "),
  );
  if (judge.ran && judge.share !== null) {
    check(`judge pass share >= ${pct(PASS.share)}`, judge.share >= PASS.share, pct(judge.share));
  }

  const promptVersions: Record<string, string> = { drafting: DRAFT_VERSION, judge: JUDGE_VERSION };
  for (const [k, p] of Object.entries(EXTRACTION_PROMPTS))
    promptVersions[`extraction.${k}`] = p.VERSION;
  return {
    date: new Date().toISOString(),
    commit: gitCommit(),
    mode: options.mode,
    limit: limit ?? null,
    models: { extraction: extraction.model, drafting: drafting.model, judge: JUDGE_MODEL },
    prompt_versions: promptVersions,
    rubric: { version: RUBRIC_VERSION, sha: rubricSha(), path: "packages/agent/evals/rubric.md" },
    ground_truth: gt,
    extraction,
    drafting,
    m2_run: m2,
    grounding: { answerable, grounded, rate: groundingRate },
    mutation,
    adversarial,
    trajectory,
    judge,
    // A replayed reply carries the usage it was billed when recorded; replaying it costs nothing.
    cost: {
      total_usd: live ? Number((spent() / USD).toFixed(6)) : 0,
      calls: live
        ? stores.reduce((a, s) => a + s.steps.filter((x) => x.costNanoUsd > 0).length, 0)
        : 0,
      cap_usd: live ? capUsd : null,
      recorded_usd: live ? 0 : Number((spent() / USD).toFixed(6)),
    },
    thresholds,
    failures,
    passed: failures.length === 0,
  };
}

const table = (rows: CaseOutcome[]) =>
  [
    "| Case | Result | Detail |",
    "|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id.replace(/\|/g, "/")} | ${r.passed ? "pass" : "**FAIL**"} | ${r.detail.replace(/\|/g, "/").replace(/\n/g, " ")} |`,
    ),
  ].join("\n");

export function renderMarkdown(r: SuiteReport): string {
  const gt = r.ground_truth;
  const total = gt.extraction.length + gt.drafting.length + gt.verifier.length;
  const ex = r.extraction;
  const adv = (cat: string) => r.adversarial.filter((c) => c.category === cat);
  return `# Eval results (M4-03)

Generated by \`npm run eval -- --mode ${r.mode}${r.limit ? ` --limit ${r.limit}` : ""}\`
(\`packages/agent/evals/suite/run.ts\`). README numbers are copied only from this file and checked by
\`python3 scripts/check-readme-numbers.py\`. ${
    r.mode === "replay"
      ? "Replay mode: every model reply is a recorded real response (fixtures/anthropic/), no network call, no spend. The numbers show the pipeline and the verifier over those recordings; they are not a fresh measure of the model."
      : "Live mode: extraction and drafting called the model through the harness, under the spend cap below."
  }

- date: ${r.date}
- commit: ${r.commit}
- mode: ${r.mode}
- models: extraction ${r.models.extraction}, drafting ${r.models.drafting}, judge ${r.models.judge}
- prompt versions: ${Object.entries(r.prompt_versions)
    .map(([k, v]) => `${k} \`${v}\``)
    .join(", ")}
- rubric: ${r.rubric.path} (${r.rubric.version}, sha256 ${r.rubric.sha})
- mutation seed: ${r.mutation.seed}

## Summary

- cases: ${total}
- ground-truth cases passed: ${[...gt.extraction, ...gt.drafting, ...gt.verifier].filter((c) => c.passed).length}
- extraction cases: ${gt.extraction.length}
- drafting cases: ${gt.drafting.length}
- verifier cases: ${gt.verifier.length}
- adversarial cases: ${r.adversarial.length}
- trajectory checks: ${r.trajectory.length}
- mutants: ${r.mutation.mutants}
- mutation rejection: ${pct(r.mutation.mutants === 0 ? 0 : r.mutation.rejected / r.mutation.mutants)}
- grounding rate: ${pct(r.grounding.rate)}
- extraction accuracy: ${pct(ex.value_accuracy)}
- quote verification: ${pct(ex.quote_verified_rate)}
- judge: ${r.judge.ran ? `${r.judge.passed} of ${r.judge.judged} judged answers pass (${r.judge.share === null ? "none judged" : pct(r.judge.share)})` : "not run (replay mode: the judge is a model call)"}
- cost: USD ${r.cost.total_usd.toFixed(6)}${r.cost.cap_usd !== null ? ` (cap USD ${r.cost.cap_usd.toFixed(2)})` : ""}
- result: ${r.passed ? "PASS" : "FAIL"}

## Thresholds

${r.thresholds.map((t) => `- ${t}`).join("\n")}

## Failures

${r.failures.length === 0 ? "None." : r.failures.map((f) => `- ${f}`).join("\n")}

## Ground truth

Extraction: ${ex.facts_correct} of ${ex.facts_scored} ground-truth fields right (field-level accuracy
${pct(ex.value_accuracy)}); ${ex.facts_verified_text_pdfs} of ${ex.facts_extracted_text_pdfs} extracted facts on text PDFs had their
quote found on the stated page of the PDF text layer (${pct(ex.quote_verified_rate)}); wrong but verified: ${ex.wrong_but_verified};
quote mutations detected: ${ex.mutation.detected} of ${ex.mutation.total}.

Grounding: ${r.grounding.grounded} of ${r.grounding.answerable} answerable questions came back VERIFIED (every claim matched to a cited
fact's quote by the verifier): ${r.drafting.grounded} of ${r.drafting.answerable} in the dataset drafting set and ${r.m2_run.grounded} of
${r.m2_run.answerable} in M2's recorded live run (M2-09). Unanswerable questions returned NEEDS_OWNER: ${r.drafting.unanswerable_needs_owner} of ${r.drafting.unanswerable}.

A failed ground-truth row is reported, not hidden, with the verifier's reason; the thresholds above
decide the result.

${table([...gt.extraction, ...gt.drafting, ...gt.verifier])}

## Mutation set

${r.mutation.good_drafts} good drafts (${r.mutation.good_accepted} accepted unmutated), ${r.mutation.mutants} mutants, ${r.mutation.rejected} rejected.
${r.mutation.weakened ? "\n**Weakened verifier (EVAL_WEAKEN_VERIFIER=1, test only).**\n" : ""}
| Class | Mutants | Rejected |
|---|---|---|
${Object.entries(r.mutation.per_class)
  .filter(([, v]) => v.mutants > 0)
  .map(([k, v]) => `| ${k} | ${v.mutants} | ${v.rejected} |`)
  .join("\n")}

Survivors: ${r.mutation.survivors.length === 0 ? "none." : `\n\n${r.mutation.survivors.map((s) => `- [${s.class} ${s.variant}] ${s.draft}: "${s.text}"`).join("\n")}`}

Not covered: swapping two values that are both in the cited facts (for example the invoice date for the
due date) uses only supported words and is accepted by design; the owner's review of the cited snippets
is the control for that (docs/evidence/verifier-eval.md).

## Adversarial set

${ADVERSARIAL_CATEGORIES.map((c) => `### ${c} (${adv(c).length})\n\n${table(adv(c))}`).join("\n\n")}

## Trajectory

${table(r.trajectory)}

## Judge

Rubric: ${r.rubric.path} (${r.rubric.version}). The judge runs after the code assertions, only on VERIFIED
text answers, sees the question and the answer text only, and can only add a failure: a failed code
assertion is never overridden (\`combineVerdict\`, tested in packages/agent/test/eval-suite.test.ts).
Limits: one model grading another, default sampling (Sonnet 5.5 rejects a non-default temperature), a
builder-written rubric with no human calibration set.

${
  r.judge.ran
    ? `| Answer | Fluency | Helpfulness | Final |\n|---|---|---|---|\n${r.judge.scores
        .map(
          (s) =>
            `| ${s.case}/${s.question} | ${s.score?.fluency ?? "-"} | ${s.score?.helpfulness ?? "-"} | ${s.final} |`,
        )
        .join("\n")}`
    : "Not run in replay mode."
}

## Cost

USD ${r.cost.total_usd.toFixed(6)} over ${r.cost.calls} billed model call(s)${
    r.cost.cap_usd !== null
      ? `, cap EVAL_SPEND_CAP_USD=${r.cost.cap_usd}`
      : ` (replay: no model call). The recorded replies cost USD ${r.cost.recorded_usd.toFixed(6)} when they were made (M2-02, M2-05).`
  }
`;
}
