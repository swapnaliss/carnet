// LLM-as-judge for draft wording (M4-03 Scope 5). Runs after the code assertions, only on answers the
// verifier accepted, only in live mode, through the harness (kill switch, spend cap, call limits). It sees
// the question and the answer text, nothing else (no ground truth, no facts, no verdict). Its score can
// only fail a case, never pass one that a code assertion failed: `combineVerdict`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { wrapUntrusted } from "../../src/guardrail";
import type { Harness, RunHandle } from "../../src/harness";
import type { ModelId } from "../../src/pricing";
import { promptVersion } from "../../src/prompt-version";

export const JUDGE_MODEL: ModelId = "claude-sonnet-5-5";
export const RUBRIC_PATH = fileURLToPath(new URL("../rubric.md", import.meta.url));
export const RUBRIC_VERSION = "rubric@1";
export const PASS = { min: 3, mean: 3.5, share: 0.9 } as const;

export function rubricSha(): string {
  return createHash("sha256").update(readFileSync(RUBRIC_PATH)).digest("hex").slice(0, 12);
}

export const JudgeSchema = z.object({
  fluency: z.number().int().min(1).max(5),
  helpfulness: z.number().int().min(1).max(5),
  rationale: z.string(),
});
export type JudgeScore = z.infer<typeof JudgeSchema>;

const SYSTEM = [
  "You grade the wording of one answer to a bank compliance question, using the rubric given.",
  "Score fluency and helpfulness from 1 to 5 by the rubric's anchors. Judge wording only: do not judge",
  "whether the answer is true, you cannot know. Give a one-sentence rationale.",
].join("\n");
export const JUDGE_VERSION = promptVersion(SYSTEM, JudgeSchema);

export const judgePasses = (s: JudgeScore): boolean =>
  s.fluency >= PASS.min &&
  s.helpfulness >= PASS.min &&
  (s.fluency + s.helpfulness) / 2 >= PASS.mean;

/**
 * The final verdict of a case. Code assertions decide; the judge can only add a failure. A failed code
 * assertion is never overridden by any judge score.
 */
export function combineVerdict(
  codePassed: boolean,
  judge: JudgeScore | null,
): { passed: boolean; by: "code" | "judge" | "code+judge" } {
  if (!codePassed) return { passed: false, by: "code" };
  if (judge === null) return { passed: true, by: "code" };
  return { passed: judgePasses(judge), by: "code+judge" };
}

export async function judgeAnswer(params: {
  harness: Harness;
  run: RunHandle;
  step: string;
  question: { title: string; description: string };
  answerText: string;
}): Promise<JudgeScore | null> {
  const rubric = readFileSync(RUBRIC_PATH, "utf8");
  const outcome = await params.harness.callStructured({
    run: params.run,
    step: params.step,
    promptVersion: JUDGE_VERSION,
    model: JUDGE_MODEL,
    system: SYSTEM,
    blocks: [
      { type: "text", text: wrapUntrusted("rubric", rubric) },
      {
        type: "text",
        text: wrapUntrusted("question", `${params.question.title}\n${params.question.description}`),
      },
      { type: "text", text: wrapUntrusted("answer", params.answerText) },
    ],
    schema: JudgeSchema,
    maxTokens: 400,
  });
  return outcome.outcome === "ok" || outcome.outcome === "replayed" ? outcome.output : null;
}
