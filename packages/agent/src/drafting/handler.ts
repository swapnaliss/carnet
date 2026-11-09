// The `rfi.draft` job body (M2-05, ADR 0005). packages/agent may import only the domain, so the RFI, its
// questions, the evidence and the stored draft live behind a port that apps/web implements over the
// repositories. The job is idempotent: a retry after a crash finds the model's stored output in the
// harness (no second call) and the draft write is keyed by the job id, so one job stores one draft.
import type { Harness } from "../harness";
import type { ModelId } from "../pricing";
import {
  DRAFT_RUN_KIND,
  type DraftInput,
  type DraftResult,
  draftRfi,
  timedOutDraft,
} from "./draft";

export interface DraftingStore {
  /**
   * The questions to draft for the RFI's `round` (those marked `needs_drafting`), the evidence the
   * business has, and whether the RFI is still waiting for a draft. Null when this business has no
   * such RFI or round.
   */
  loadInput(
    rfiId: string,
    round: number,
  ): Promise<{ input: DraftInput; awaitingDraft: boolean } | null>;
  /**
   * Inserts the draft and its answers, moves the RFI DRAFTING -> DRAFT_READY | NEEDS_OWNER (through the
   * state machine, audited) and publishes `draft.ready` | `draft.needs_owner`, all in one transaction.
   * `draftKey` makes it idempotent: a second call with the same key inserts nothing.
   */
  saveDraft(input: {
    rfiId: string;
    round: number;
    draftKey: string;
    runId: string | null;
    origin: "model" | "system";
    result: DraftResult;
  }): Promise<{ draftId: string; state: "DRAFT_READY" | "NEEDS_OWNER"; inserted: boolean }>;
}

export interface RunDraftingParams {
  readonly harness: Harness;
  readonly store: DraftingStore;
  readonly rfiId: string;
  readonly round: number;
  /** The job id: stable across retries of one job, new for a deliberate re-draft. */
  readonly draftKey: string;
  readonly model?: ModelId;
}

export interface RunDraftingResult {
  readonly outcome: "drafted" | "skipped";
  readonly draftId: string | null;
  readonly state: "DRAFT_READY" | "NEEDS_OWNER" | null;
  readonly kind: DraftResult["kind"] | null;
}

export const draftStep = (round: number, draftKey: string) => `draft:r${round}:${draftKey}`;

export async function runDrafting(params: RunDraftingParams): Promise<RunDraftingResult> {
  const { harness, store, rfiId, round, draftKey } = params;
  const loaded = await store.loadInput(rfiId, round);
  if (!loaded) throw new Error(`rfi ${rfiId} round ${round} not found`);
  if (!loaded.awaitingDraft) return { outcome: "skipped", draftId: null, state: null, kind: null };

  const run = await harness.startRun({ kind: DRAFT_RUN_KIND, ref: rfiId });
  let result: DraftResult;
  try {
    result = await draftRfi({
      harness,
      run,
      step: draftStep(round, draftKey),
      input: loaded.input,
      ...(params.model ? { model: params.model } : {}),
    });
  } catch (error) {
    await harness.finishRun(run, "FAILED");
    throw error;
  }
  await harness.finishRun(run, result.kind === "model" ? "DONE" : "FAILED");
  const saved = await store.saveDraft({
    rfiId,
    round,
    draftKey,
    runId: run.id,
    origin: "model",
    result,
  });
  return { outcome: "drafted", ...saved, state: saved.state, kind: result.kind };
}

/**
 * The timeout sweeper's body: an RFI that is still DRAFTING after the run limit gets a system draft in
 * which every question is NEEDS_OWNER (`MODEL_UNAVAILABLE`, detail `draft_timeout`), so the owner can
 * write the answers. A draft that arrives in the meantime wins: nothing is written when the RFI is no
 * longer waiting.
 */
export async function runDraftTimeout(params: {
  store: DraftingStore;
  rfiId: string;
  round: number;
}): Promise<RunDraftingResult> {
  const { store, rfiId, round } = params;
  const loaded = await store.loadInput(rfiId, round);
  if (!loaded || !loaded.awaitingDraft) {
    return { outcome: "skipped", draftId: null, state: null, kind: null };
  }
  const saved = await store.saveDraft({
    rfiId,
    round,
    draftKey: `timeout:r${round}`,
    runId: null,
    origin: "system",
    result: timedOutDraft(loaded.input),
  });
  return { outcome: "drafted", ...saved, kind: "unavailable" };
}
