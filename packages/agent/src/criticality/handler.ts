// The `obligation.criticality.propose` job body (M3-01, ADR 0005). packages/agent may import only the
// domain, so the contract and the stored proposal live behind a port that apps/web implements over the
// repositories. The port has no method that sets a criticality: a proposal is all the agent can write.
// Idempotent: a retry after a crash finds the model's stored output in the harness (no second call), and
// the proposal write is keyed by the job id, so one job stores at most one proposal.
import type { Harness } from "../harness";
import type { ModelId } from "../pricing";
import {
  type ContractDocument,
  CRITICALITY_RUN_KIND,
  type CriticalityResult,
  proposeCriticality,
} from "./propose";

export interface CriticalityStore {
  /** The contract's mime and bytes, or null when this business has no such contract document. */
  loadContract(obligationId: string, documentId: string): Promise<ContractDocument | null>;
  /**
   * Inserts the proposal (`PROPOSED`, or `REJECTED` with its reason) and an audit entry, in one
   * transaction. `proposalKey` makes it idempotent. It never touches the obligation's criticality.
   */
  saveProposal(input: {
    obligationId: string;
    documentId: string;
    proposalKey: string;
    runId: string;
    result: CriticalityResult;
  }): Promise<{ proposalId: string; inserted: boolean }>;
}

export interface RunCriticalityParams {
  readonly harness: Harness;
  readonly store: CriticalityStore;
  readonly obligationId: string;
  readonly documentId: string;
  /** The job id: stable across retries of one job, new for a deliberate re-proposal. */
  readonly proposalKey: string;
  readonly model?: ModelId;
}

export interface RunCriticalityResult {
  readonly verifierResult: CriticalityResult["verifierResult"];
  readonly reason: string | null;
  readonly proposalId: string;
  readonly inserted: boolean;
}

export const criticalityStep = (proposalKey: string) => `criticality:${proposalKey}`;

export async function runCriticalityProposal(
  params: RunCriticalityParams,
): Promise<RunCriticalityResult> {
  const { harness, store, obligationId, documentId, proposalKey } = params;
  const document = await store.loadContract(obligationId, documentId);
  if (!document) throw new Error(`contract ${documentId} for obligation ${obligationId} not found`);

  const run = await harness.startRun({ kind: CRITICALITY_RUN_KIND, ref: obligationId });
  let result: CriticalityResult;
  try {
    result = await proposeCriticality({
      harness,
      run,
      step: criticalityStep(proposalKey),
      document,
      ...(params.model ? { model: params.model } : {}),
    });
  } catch (error) {
    await harness.finishRun(run, "FAILED");
    throw error;
  }
  const callFailed =
    result.verifierResult === "REJECTED" &&
    (result.reason === "model_unavailable" || result.reason === "no_text_layer");
  await harness.finishRun(run, callFailed ? "FAILED" : "DONE");
  const saved = await store.saveProposal({
    obligationId,
    documentId,
    proposalKey,
    runId: run.id,
    result,
  });
  return {
    verifierResult: result.verifierResult,
    reason: result.verifierResult === "REJECTED" ? result.reason : null,
    ...saved,
  };
}
