import type { BusinessId } from "@carnet/domain";
import { and, eq } from "drizzle-orm";
import { DuplicateIdempotencyKeyError, pgErrorOf, translateDbError } from "../errors";
import { idempotencyKeys } from "../schema/index";
import type { RepoCtx } from "./context";

export interface IdempotencyRecord {
  readonly businessId: BusinessId;
  readonly endpoint: string;
  readonly key: string;
  /** Hash of the canonical request body; the same key with another hash is IDEMPOTENCY_KEY_REUSED. */
  readonly requestHash: string;
  readonly responseStatus: number;
  readonly response: unknown;
  readonly createdAt: Date;
}

type Row = typeof idempotencyKeys.$inferSelect;
const toRecord = (r: Row): IdempotencyRecord => ({
  businessId: r.businessId as BusinessId,
  endpoint: r.endpoint,
  key: r.key,
  requestHash: r.requestHash,
  responseStatus: r.responseStatus,
  response: r.response,
  createdAt: r.createdAt,
});

export async function getIdempotencyRecord(
  ctx: RepoCtx,
  endpoint: string,
  key: string,
): Promise<IdempotencyRecord | null> {
  const [row] = await ctx.db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.businessId, ctx.businessId),
        eq(idempotencyKeys.endpoint, endpoint),
        eq(idempotencyKeys.key, key),
      ),
    );
  return row ? toRecord(row) : null;
}

export interface NewIdempotencyRecord {
  endpoint: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  response: unknown;
}

/** Throws DuplicateIdempotencyKeyError when the key is already recorded for this business. */
export async function saveIdempotencyRecord(
  ctx: RepoCtx,
  input: NewIdempotencyRecord,
): Promise<IdempotencyRecord> {
  try {
    const [row] = await ctx.db
      .insert(idempotencyKeys)
      .values({ ...input, businessId: ctx.businessId })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return toRecord(row);
  } catch (error) {
    const pgError = pgErrorOf(error);
    if (pgError?.code === "23505" && pgError.constraint === "idempotency_keys_pkey") {
      throw new DuplicateIdempotencyKeyError(input.endpoint, input.key);
    }
    throw translateDbError(error);
  }
}
