// /api/v1/obligations request and response shapes (M3-01, ADR 0004). Money is an integer in minor units
// carried as a decimal string (it can exceed 2^53); the currency is its own field.
import { z } from "zod";
import { CurrencySchema, IsoTimestampSchema } from "../schemas";
import {
  CRITICALITY_PROPOSAL_STATUSES,
  CRITICALITY_REJECT_REASONS,
  CRITICALITY_VERIFIER_RESULTS,
} from "./criticality";

export const ObligationIdSchema = z.uuid();

const MINOR_DIGITS = /^[1-9][0-9]{0,17}$/;

export const CreateObligationBodySchema = z.strictObject({
  counterparty_id: z.uuid(),
  /** Integer minor units as a decimal string, greater than zero (at most 18 digits). */
  amount_minor: z
    .string()
    .regex(MINOR_DIGITS, "an integer number of minor units, greater than zero"),
  currency: CurrencySchema,
  due_at: IsoTimestampSchema,
  payment_id: z.uuid().optional(),
  source_document_id: z.uuid().optional(),
});
export type CreateObligationBody = z.infer<typeof CreateObligationBodySchema>;

export const ListObligationsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** The contract to read; default is the obligation's own source document. */
export const ProposeCriticalityBodySchema = z.strictObject({
  document_id: z.uuid().optional(),
});
export type ProposeCriticalityBody = z.infer<typeof ProposeCriticalityBodySchema>;

/** `proposal_id` is the proposal the owner saw (omit it when none was shown). */
export const ConfirmCriticalityBodySchema = z.strictObject({
  criticality: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  proposal_id: z.uuid().optional(),
});
export type ConfirmCriticalityBody = z.infer<typeof ConfirmCriticalityBodySchema>;

export const CriticalityProposalViewSchema = z.strictObject({
  id: z.string(),
  obligation_id: z.string(),
  document_id: z.string(),
  proposed_criticality: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
  rationale: z.string(),
  quote: z.string(),
  quote_page: z.number().int().nullable(),
  verifier_result: z.enum(CRITICALITY_VERIFIER_RESULTS),
  verifier_reason: z.enum(CRITICALITY_REJECT_REASONS).nullable(),
  /** Shown to the owner when the verifier rejected the proposal. */
  message: z.string().nullable(),
  status: z.enum(CRITICALITY_PROPOSAL_STATUSES),
  injection_suspected: z.boolean(),
  injection_flags: z.array(
    z.strictObject({ kind: z.string(), rule: z.string(), match: z.string() }),
  ),
  prompt_version: z.string().nullable(),
  created_at: z.string(),
});
export type CriticalityProposalView = z.infer<typeof CriticalityProposalViewSchema>;

export const ObligationViewSchema = z.strictObject({
  id: z.string(),
  business_id: z.string(),
  counterparty_id: z.string(),
  amount_minor: z.string(),
  currency: z.string(),
  due_at: z.string(),
  /** The confirmed value, or null. */
  criticality: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
  /** What the planner uses: the confirmed value or `UNCONFIRMED`. */
  planning_criticality: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal("UNCONFIRMED"),
  ]),
  criticality_confirmed_by: z.string().nullable(),
  criticality_confirmed_at: z.string().nullable(),
  criticality_confirmed_proposal_id: z.string().nullable(),
  payment_id: z.string().nullable(),
  source_document_id: z.string().nullable(),
  created_at: z.string(),
  /** The newest proposal, if any (it never changes `criticality`). */
  latest_proposal: CriticalityProposalViewSchema.nullable(),
});
export type ObligationView = z.infer<typeof ObligationViewSchema>;

export const ObligationListResponseSchema = z.strictObject({
  items: z.array(ObligationViewSchema),
});

export const ProposeCriticalityResponseSchema = z.strictObject({
  obligation_id: z.string(),
  document_id: z.string(),
  status: z.literal("QUEUED"),
});

export type ProposeCriticalityResponse = z.infer<typeof ProposeCriticalityResponseSchema>;

export const CRITICALITY_AUDIT_ACTIONS = {
  created: "obligation.created",
  proposeRequested: "obligation.criticality_propose_requested",
  proposed: "obligation.criticality_proposed",
  confirmed: "obligation.criticality_confirmed",
} as const;
