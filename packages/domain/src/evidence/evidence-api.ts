// The shapes the evidence API shares with the repository and the screens (M2-03).
import { z } from "zod";
import { DocumentIdSchema } from "../schemas";
import { DEFAULT_CONTRACT_THRESHOLD_MINOR, type EvidencePolicy } from "./rules";
import { EVIDENCE_FLAGS } from "./strength";

/** Audit action written when an owner sends a payment whose evidence is Weak or Missing. */
export const EVIDENCE_AUDIT_ACTIONS = { override: "evidence_override" } as const;

/** `businesses.evidence_policy` (jsonb). Amounts are integers in minor units, keyed by currency. */
export const EvidencePolicyJsonSchema = z.strictObject({
  contract_required_above_minor: z
    .record(z.string().regex(/^[A-Z]{3}$/), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
    .default({}),
});
export type EvidencePolicyJson = z.infer<typeof EvidencePolicyJsonSchema>;

/** The stored policy as the rules read it. An empty or unreadable value means the defaults. */
export function parseEvidencePolicy(json: unknown): EvidencePolicy {
  const parsed = EvidencePolicyJsonSchema.safeParse(json ?? {});
  const record = parsed.success ? parsed.data.contract_required_above_minor : {};
  return {
    contractRequiredAboveMinor: Object.fromEntries(
      Object.entries(record).map(([currency, minor]) => [currency, BigInt(minor)]),
    ),
  };
}

export { DEFAULT_CONTRACT_THRESHOLD_MINOR };

/**
 * An owner's acknowledgement that a Weak or Missing payment is sent anyway. `check_hash` binds it to the
 * exact check the owner saw (flag, rules, reasons, fact versions): if the evidence changed since, the
 * server answers 409 and the owner sees the new check. The screens always send it.
 */
export const EvidenceAckSchema = z.strictObject({
  acknowledged: z.literal(true),
  check_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type EvidenceAck = z.infer<typeof EvidenceAckSchema>;

export const SendPaymentBodySchema = z.strictObject({
  evidence_ack: EvidenceAckSchema.optional(),
});
export type SendPaymentBody = z.infer<typeof SendPaymentBodySchema>;

export const AttachEvidenceBodySchema = z.strictObject({
  document_id: DocumentIdSchema,
});
export type AttachEvidenceBody = z.infer<typeof AttachEvidenceBodySchema>;

export const EvidenceFlagSchema = z.enum(EVIDENCE_FLAGS);
