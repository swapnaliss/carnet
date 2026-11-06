// Shared zod base schemas for the REST API and the worker (ADR 0004).
import { z } from "zod";
import type {
  ApprovalId,
  AttemptId,
  BusinessId,
  CounterpartyId,
  DocumentId,
  PaymentId,
  RequestId,
  RfiId,
  RunId,
  UserId,
} from "./ids";
import {
  CURRENCIES,
  type Currency,
  formatMajor,
  type Money,
  MoneyError,
  parseMajor,
} from "./money";
import { TRANSFER_STATUSES } from "./status";

const uuidOf = <T extends string>() => z.uuid().transform((s) => s as T);

export const BusinessIdSchema = uuidOf<BusinessId>();
export const UserIdSchema = uuidOf<UserId>();
export const PaymentIdSchema = uuidOf<PaymentId>();
export const CounterpartyIdSchema = uuidOf<CounterpartyId>();
export const RfiIdSchema = uuidOf<RfiId>();
export const AttemptIdSchema = uuidOf<AttemptId>();
export const ApprovalIdSchema = uuidOf<ApprovalId>();
export const RunIdSchema = uuidOf<RunId>();
export const RequestIdSchema = uuidOf<RequestId>();
export const DocumentIdSchema = uuidOf<DocumentId>();

export const CurrencySchema = z.enum(CURRENCIES as [Currency, ...Currency[]]);

export const TransferStatusSchema = z.enum(TRANSFER_STATUSES);

/** ISO 8601 timestamp with `Z` or a `±hh:mm` offset. */
export const IsoTimestampSchema = z.iso.datetime({ offset: true });

/** Money on the wire: a major-unit decimal string plus a currency. */
export const MoneyWireSchema = z.strictObject({
  amount: z.string().min(1).max(40),
  currency: CurrencySchema,
});

export type MoneyWire = z.infer<typeof MoneyWireSchema>;

/** Parses the wire form into Money (minor units); rejects too many decimals and non-numeric input. */
export const MoneySchema = MoneyWireSchema.transform((wire, ctx): Money => {
  try {
    return parseMajor(wire.amount, wire.currency);
  } catch (e) {
    ctx.addIssue({
      code: "custom",
      path: ["amount"],
      message: e instanceof MoneyError ? e.message : "invalid amount",
    });
    return z.NEVER;
  }
});

export function toMoneyWire(value: Money): MoneyWire {
  return { amount: formatMajor(value), currency: value.currency };
}

/** Opaque cursor (base64url) for cursor pagination. */
export const CursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const PageQuerySchema = z.strictObject({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item), next_cursor: CursorSchema.nullable() });
}
