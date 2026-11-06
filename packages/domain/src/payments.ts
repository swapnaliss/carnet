// Payments API contract (M1-08): request bodies of `POST /api/v1/payments` and of the owner-only
// sandbox simulation action, plus the Idempotency-Key header rule (ADR 0004). Money on the wire is
// a major-unit decimal string plus a currency; it is parsed into minor units here.
import { z } from "zod";
import { CounterpartyIdSchema, MoneySchema } from "./schemas";

/** `Idempotency-Key`: 8 to 128 visible ASCII characters (a UUID from the client is typical). */
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[\x21-\x7e]+$/);

export const PAYMENT_REFERENCE_MAX = 140;

export const CreatePaymentBodySchema = z.strictObject({
  /** The amount the beneficiary receives, in its currency (the source currency is the same here). */
  amount: MoneySchema,
  reference: z.string().trim().min(1).max(PAYMENT_REFERENCE_MAX),
  /** Defaults to the business's demo counterparty. */
  counterparty_id: CounterpartyIdSchema.optional(),
});

export type CreatePaymentBody = z.output<typeof CreatePaymentBodySchema>;

/**
 * The sandbox transitions an owner may trigger. The sandbox moves a new transfer to PROCESSING on its
 * own, then accepts SENT, then PAID (M0-03, docs/evidence/airwallex-money-path.md).
 */
export const SIMULATED_TRANSITIONS = ["SENT", "PAID"] as const;
export type SimulatedTransition = (typeof SIMULATED_TRANSITIONS)[number];

export const SimulateTransferBodySchema = z.strictObject({
  next_status: z.enum(SIMULATED_TRANSITIONS),
});

export type SimulateTransferBody = z.output<typeof SimulateTransferBodySchema>;
