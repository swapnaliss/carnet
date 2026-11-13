// `obligation.criticality.propose` (M3-01, ADR 0005, 0009, 0011): reads the contract, runs the proposal
// through the agent harness, and stores the proposal and its audit entry in one transaction. This handler
// can write a proposal and nothing else: it does not import the confirm repository, so no worker code path
// sets an obligation's criticality (test/obligations/no-self-confirmation.test.ts greps for it).
// Idempotent: a retry replays the model's stored output (no second call) and the write is keyed by the job id.
import {
  type CriticalityStore,
  createHarness,
  isModelId,
  runCriticalityProposal,
  type Transport,
} from "@carnet/agent";
import {
  agentHarnessStore,
  appendAudit,
  getDocumentContent,
  getObligation,
  insertCriticalityProposal,
  repoCtx,
  withTransaction,
} from "@carnet/db";
import { type BusinessId, CRITICALITY_AUDIT_ACTIONS, type DocumentId } from "@carnet/domain";
import { OBLIGATION_JOB_KIND } from "../../server/obligations/jobs";
import { type HandlerContext, type JobHandler, payloadString } from "./index";

export { OBLIGATION_JOB_KIND };

const ACTOR = { actorType: "system", actorId: "worker" } as const;

export function criticalityStoreFor(
  ctx: Pick<HandlerContext, "db">,
  businessId: BusinessId,
): CriticalityStore {
  const repo = repoCtx(ctx.db, businessId);
  return {
    async loadContract(obligationId, documentId) {
      if (!(await getObligation(repo, obligationId))) return null;
      const content = await getDocumentContent(repo, documentId as DocumentId);
      if (!content || content.document.kind !== "contract") return null;
      return { mime: content.document.mime, bytes: content.bytes };
    },
    async saveProposal({ obligationId, documentId, proposalKey, runId, result }) {
      return withTransaction(ctx.db, async (tx) => {
        const rc = repoCtx(tx, businessId);
        const rejected = result.verifierResult === "REJECTED";
        const { proposal, inserted } = await insertCriticalityProposal(rc, {
          obligationId,
          documentId,
          proposalKey,
          agentRunId: runId,
          verifierResult: result.verifierResult,
          verifierReason: result.verifierResult === "REJECTED" ? result.reason : null,
          proposedCriticality: result.verifierResult === "VERIFIED" ? result.proposed : null,
          rationale: result.rationale,
          quote: result.quote,
          quotePage: result.verifierResult === "VERIFIED" ? result.page : null,
          injectionSuspected: result.injectionSuspected,
          injectionFlags: result.injectionFlags,
          promptVersion: result.promptVersion,
          model: result.model,
        });
        if (inserted) {
          await appendAudit(rc, {
            ...ACTOR,
            action: CRITICALITY_AUDIT_ACTIONS.proposed,
            subject: `obligation:${obligationId}`,
            data: {
              proposal_id: proposal.id,
              document_id: documentId,
              verifier_result: result.verifierResult,
              verifier_reason: rejected ? result.reason : null,
              injection_suspected: result.injectionSuspected,
              agent_run_id: runId,
            },
          });
        }
        return { proposalId: proposal.id, inserted };
      });
    },
  };
}

export interface CriticalityHandlerOptions {
  /** HTTP transport for the model client (tests replay recorded responses); default: global fetch. */
  readonly transport?: Transport;
}

export function createCriticalityProposeHandler(
  options: CriticalityHandlerOptions = {},
): JobHandler {
  return async (payload, ctx, job) => {
    const businessId = payloadString(payload, "businessId") as BusinessId;
    const obligationId = payloadString(payload, "obligationId");
    const documentId = payloadString(payload, "documentId");
    const harness = createHarness({
      store: agentHarnessStore(repoCtx(ctx.db, businessId)),
      ...(options.transport ? { transport: options.transport } : {}),
    });
    const configured = process.env.ANTHROPIC_MODEL_DRAFT;
    const model = configured && isModelId(configured) ? configured : undefined;
    const out = await runCriticalityProposal({
      harness,
      store: criticalityStoreFor(ctx, businessId),
      obligationId,
      documentId,
      proposalKey: job.id,
      ...(model ? { model } : {}),
    });
    ctx.logger.info({ businessId, obligationId, documentId, ...out }, "criticality proposed");
  };
}

export const handleCriticalityPropose: JobHandler = createCriticalityProposeHandler();
