// Trajectory checks (M4-03 Scope 2). Two parts:
//   1. the stored agent steps of the suite's own replay (the harness writes one step per model call, as
//      agent_steps does in Postgres): every step's output validates against its zod schema, its stop
//      reason is end_turn (never an unhandled refusal or max_tokens), and no question used more than the
//      harness limit of two calls; and the evidence each answer used is the expected document.
//   2. recovery: tool/model errors injected at the transport (timeout, 529, malformed JSON, refusal,
//      max_tokens, 500), always and once. The pipeline makes at most two model calls per question, then
//      degrades every question to NEEDS_OWNER; a re-run of the same question makes no request at all.
import type { z } from "zod";
import { DRAFT_RUN_KIND, type DraftInput, draftRfi } from "../../src/drafting/draft";
import { VERSION as DRAFT_VERSION, Schema as DraftSchema } from "../../src/drafting/prompts/draft";
import { DEFAULT_LIMITS } from "../../src/harness";
import { createHarness, EXTRACTION_PROMPTS, type Transport } from "../../src/index";
import { type MemoryStore, memoryStore } from "../../test/memory-store";
import type { DraftingCase, QuestionReport } from "../drafting/run";
import { loadDraftRecording } from "../drafting/run";
import { replayTransport } from "../extraction/run";
import {
  type CaseOutcome,
  errorResponse,
  fail,
  hangUntilAborted,
  messageResponse,
  pass,
  sequence,
} from "./support";

const SCHEMAS = new Map<string, z.ZodType>([
  [DRAFT_VERSION, DraftSchema],
  ...Object.values(EXTRACTION_PROMPTS).map((p) => [p.VERSION, p.Schema] as [string, z.ZodType]),
]);

/** Part 1: the stored steps of a replay run, and evidence retrieval per question. */
export function storedStepChecks(
  stores: readonly MemoryStore[],
  questions: readonly QuestionReport[],
): CaseOutcome[] {
  const cat = "trajectory";
  const out: CaseOutcome[] = [];
  const steps = stores.flatMap((s) => s.steps.map((st) => ({ st, run: s.runs.get(st.runId) })));
  const badSchema = steps.filter(({ st }) => {
    const schema = SCHEMAS.get(st.promptVersion);
    return st.outcome === "ok" && !schema?.safeParse(st.output).success;
  });
  out.push(
    steps.length > 0 && badSchema.length === 0
      ? pass(
          "every stored step output validates against its zod schema",
          cat,
          `${steps.length} steps`,
        )
      : fail(
          "every stored step output validates against its zod schema",
          cat,
          `${badSchema.length} of ${steps.length} invalid`,
        ),
  );
  const badStop = steps.filter(({ st }) => st.outcome === "ok" && st.stopReason !== "end_turn");
  const unhandled = steps.filter(
    ({ st }) =>
      (st.stopReason === "refusal" || st.stopReason === "max_tokens") && st.outcome === "ok",
  );
  out.push(
    badStop.length === 0 && unhandled.length === 0
      ? pass(
          "no accepted step stopped on refusal or max_tokens",
          cat,
          "all accepted steps end_turn",
        )
      : fail(
          "no accepted step stopped on refusal or max_tokens",
          cat,
          `${badStop.length + unhandled.length} step(s)`,
        ),
  );
  const perQuestion = new Map<string, number>();
  for (const { st, run } of steps) {
    const key = `${run?.kind}|${run?.ref}|${st.step}`;
    perQuestion.set(key, (perQuestion.get(key) ?? 0) + 1);
  }
  const over = [...perQuestion.entries()].filter(([, n]) => n > DEFAULT_LIMITS.maxCallsPerQuestion);
  out.push(
    over.length === 0
      ? pass(
          "at most two model calls per question",
          cat,
          `max ${Math.max(0, ...perQuestion.values())} over ${perQuestion.size} questions`,
        )
      : fail(
          "at most two model calls per question",
          cat,
          over.map(([k, n]) => `${k}=${n}`).join("; "),
        ),
  );
  // Evidence retrieval: an answered question used the documents the ground truth expects.
  const withExpected = questions.filter(
    (q) => q.expected === "ANSWER" && q.expected_documents.length > 0,
  );
  const missed = withExpected.filter((q) => {
    const used = q.answer_type === "ATTACHMENT" ? q.selected_documents : q.cited_documents;
    return !q.expected_documents.every((d) => used.includes(d));
  });
  out.push(
    missed.length === 0
      ? pass(
          "the expected evidence documents were used for each question",
          cat,
          `${withExpected.length} questions`,
        )
      : fail(
          "the expected evidence documents were used for each question",
          cat,
          missed.map((q) => `${q.case}/${q.question}`).join("; "),
        ),
  );
  return out;
}

interface Injected {
  readonly name: string;
  /** Responses served in order; the last repeats. */
  readonly responses: (() => Promise<Response> | Response)[];
  /** Whether the pipeline should end with a grounded draft (a transient error) or NEEDS_OWNER. */
  readonly recovers: boolean;
}

/** Part 2: error injection on the recorded harbor case. */
export async function recoveryChecks(cases: readonly DraftingCase[]): Promise<CaseOutcome[]> {
  const cat = "trajectory";
  const c = cases.find((x) => x.id === "rfi-set-harbor-r1");
  if (!c) return [fail("recovery setup", cat, "no harbor case")];
  const input: DraftInput = { questions: c.questions, facts: c.facts, documents: c.documents };
  const recorded = replayTransport(loadDraftRecording(c.id));
  const good = () => recorded("https://api.anthropic.com/v1/messages");
  const malformed = () =>
    messageResponse('{"answers": [ {"question_id": "q-harbor-purpose", "text": ');
  const refusal = () => messageResponse("I can't help with that.", "refusal");
  const maxTokens = () => messageResponse('{"answers": [', "max_tokens");
  const overloaded = () => errorResponse(529, "overloaded_error");
  const server = () => errorResponse(500, "api_error");
  const injected: Injected[] = [
    { name: "timeout (always)", responses: [], recovers: false },
    { name: "529 overloaded (always)", responses: [overloaded], recovers: false },
    { name: "500 server error (always)", responses: [server], recovers: false },
    { name: "malformed JSON (always)", responses: [malformed], recovers: false },
    { name: "refusal (always)", responses: [refusal], recovers: false },
    { name: "max_tokens (always)", responses: [maxTokens], recovers: false },
    {
      name: "malformed JSON once, then a good reply",
      responses: [malformed, good],
      recovers: true,
    },
    { name: "max_tokens once, then a good reply", responses: [maxTokens, good], recovers: true },
    {
      name: "529 once, then a good reply (SDK retry)",
      responses: [overloaded, good],
      recovers: true,
    },
  ];
  const out: CaseOutcome[] = [];
  for (const inj of injected) {
    const store = memoryStore({ agentsEnabled: true });
    const isTimeout = inj.name.startsWith("timeout");
    let hangs = 0;
    const hang: Transport = (i, init) => {
      hangs += 1;
      return hangUntilAborted(i, init);
    };
    const seq = isTimeout ? { transport: hang, requests: () => hangs } : sequence(inj.responses);
    const harness = createHarness({
      store,
      transport: seq.transport,
      limits: isTimeout ? { callTimeLimitMs: 150 } : {},
      maxRetries: isTimeout ? 0 : 2,
    });
    const ref = `recovery:${inj.name}`;
    const attempt = async () => {
      const run = await harness.startRun({ kind: DRAFT_RUN_KIND, ref });
      return draftRfi({ harness, run, step: "draft:job", input });
    };
    const first = await attempt();
    // The job is retried (a worker restart, a redelivered job): the same question key.
    const before = seq.requests();
    const second = inj.recovers ? first : await attempt();
    const third = inj.recovers ? first : await attempt();
    const afterRetries = seq.requests() - before;
    const steps = store.steps.filter((s) => s.step === "draft:job").length;
    const allNeedsOwner = [first, second, third].every((r) =>
      r.results.every((x) => x.verdict.status === "NEEDS_OWNER"),
    );
    const grounded = first.results.filter((x) => x.verdict.status === "VERIFIED").length;
    const ok = inj.recovers
      ? first.kind === "model" && grounded > 0 && steps <= 2
      : allNeedsOwner && steps <= DEFAULT_LIMITS.maxCallsPerQuestion && third.unavailable !== null;
    const detail = `${steps} model call(s), ${seq.requests()} HTTP request(s)${
      inj.recovers
        ? `, ${grounded} grounded`
        : `, ${afterRetries} request(s) on the 2 job retries; ${third.unavailable?.code}:${third.unavailable?.detail}`
    }`;
    out.push(
      ok ? pass(`recovery: ${inj.name}`, cat, detail) : fail(`recovery: ${inj.name}`, cat, detail),
    );
  }
  return out;
}
