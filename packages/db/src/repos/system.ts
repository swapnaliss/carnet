// System-level repositories: provider and platform tables that carry no business_id
// (webhook inbox, outbox, rate limits, system flags) and the bootstrap that creates a tenant.
// They take `db`, not a tenant context, and none of them reads a tenant table.
import { type BusinessId, type Money, newBusinessId } from "@carnet/domain";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  DuplicateWebhookEventError,
  pgErrorOf,
  SystemFlagsMissingError,
  translateDbError,
} from "../errors";
import { businesses, outboxJobs, rateLimits, systemFlags, webhookEvents } from "../schema/index";
import { moneyFromDb } from "./context";

// --- bootstrap -----------------------------------------------------------------------------------

export interface NewBusiness {
  id?: BusinessId;
  name: string;
  timezone?: string;
}

/** Creates a tenant and returns its id (seed and sign-up only). Read it back with a context. */
export async function createBusiness(db: Db, input: NewBusiness): Promise<BusinessId> {
  const [row] = await db
    .insert(businesses)
    .values({
      id: input.id ?? newBusinessId(),
      name: input.name,
      ...(input.timezone ? { timezone: input.timezone } : {}),
    })
    .returning({ id: businesses.id });
  if (!row) throw new Error("insert returned no row");
  return row.id as BusinessId;
}

// --- webhook inbox -------------------------------------------------------------------------------

export interface WebhookEvent {
  readonly id: string;
  readonly providerEventId: string;
  readonly name: string;
  readonly receivedAt: Date;
  readonly rawBody: string;
  readonly signatureOk: boolean;
  readonly processedAt: Date | null;
}

export interface NewWebhookEvent {
  providerEventId: string;
  name: string;
  rawBody: string;
  signatureOk: boolean;
}

/** Throws DuplicateWebhookEventError when the provider event id is already stored. */
export async function insertWebhookEvent(db: Db, input: NewWebhookEvent): Promise<WebhookEvent> {
  try {
    const [row] = await db.insert(webhookEvents).values(input).returning();
    if (!row) throw new Error("insert returned no row");
    return row;
  } catch (error) {
    const pgError = pgErrorOf(error);
    if (
      pgError?.code === "23505" &&
      pgError.constraint === "webhook_events_provider_event_id_key"
    ) {
      throw new DuplicateWebhookEventError(input.providerEventId);
    }
    throw translateDbError(error);
  }
}

export async function getWebhookEvent(db: Db, id: string): Promise<WebhookEvent | null> {
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, id));
  return row ?? null;
}

export async function markWebhookEventProcessed(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(webhookEvents)
    .set({ processedAt: new Date() })
    .where(eq(webhookEvents.id, id))
    .returning({ id: webhookEvents.id });
  return rows.length > 0;
}

// --- outbox --------------------------------------------------------------------------------------

export interface NewJob {
  kind: string;
  payload: unknown;
  runAfter?: Date;
}

/** Enqueue inside the caller's transaction so the job commits with the state change (ADR 0005). */
export async function enqueueJob(db: Db, job: NewJob): Promise<string> {
  const [row] = await db
    .insert(outboxJobs)
    .values({
      kind: job.kind,
      payload: job.payload,
      ...(job.runAfter ? { runAfter: job.runAfter } : {}),
    })
    .returning({ id: outboxJobs.id });
  if (!row) throw new Error("insert returned no row");
  return row.id;
}

// --- rate limits ---------------------------------------------------------------------------------

/** Atomically counts one hit in the (key, window) bucket and returns the new count. */
export async function incrementRateLimit(db: Db, key: string, windowStart: Date): Promise<number> {
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });
  if (!row) throw new Error("upsert returned no row");
  return row.count;
}

// --- system flags --------------------------------------------------------------------------------

export interface SystemFlags {
  readonly agentsEnabled: boolean;
  readonly executionEnabled: boolean;
  readonly dailySpendCap: Money;
  readonly perRunCap: Money;
  readonly updatedAt: Date;
}

/**
 * The kill switch and spend caps (M1-05 reads it before running agents or executing). Throws
 * SystemFlagsMissingError if the seeded row is gone; callers treat that as "disabled".
 */
export async function getSystemFlags(db: Db): Promise<SystemFlags> {
  const [row] = await db.select().from(systemFlags).where(eq(systemFlags.id, 1));
  if (!row) throw new SystemFlagsMissingError();
  return {
    agentsEnabled: row.agentsEnabled,
    executionEnabled: row.executionEnabled,
    dailySpendCap: moneyFromDb(row.dailySpendCapMinor, row.capCurrency),
    perRunCap: moneyFromDb(row.perRunCapMinor, row.capCurrency),
    updatedAt: row.updatedAt,
  };
}
