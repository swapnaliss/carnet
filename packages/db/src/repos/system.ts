// System-level repositories: provider and platform tables that carry no business_id
// (webhook inbox, outbox, rate limits, system flags) and the bootstrap that creates a tenant.
// They take `db`, not a tenant context, and none of them reads a tenant table.
import { type BusinessId, type Money, newBusinessId } from "@carnet/domain";
import { eq, gte, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  DuplicateWebhookEventError,
  pgErrorOf,
  SystemFlagsMissingError,
  translateDbError,
} from "../errors";
import { agentSteps, businesses, outboxJobs, systemFlags, webhookEvents } from "../schema/index";
import { moneyFromDb } from "./context";

// --- bootstrap -----------------------------------------------------------------------------------

export interface NewBusiness {
  id?: BusinessId;
  name: string;
  timezone?: string;
  /** The business's Airwallex account id (attributes orphan RFIs, M2-04). */
  airwallexAccountId?: string;
}

/** Creates a tenant and returns its id (seed and sign-up only). Read it back with a context. */
export async function createBusiness(db: Db, input: NewBusiness): Promise<BusinessId> {
  const [row] = await db
    .insert(businesses)
    .values({
      id: input.id ?? newBusinessId(),
      name: input.name,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      ...(input.airwallexAccountId ? { airwallexAccountId: input.airwallexAccountId } : {}),
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
  /** When the request arrived (M1-09 ack latency); defaults to the insert time. */
  receivedAt?: Date;
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

// --- model spend ---------------------------------------------------------------------------------

/**
 * Model spend in nano-USD of every step since `since`, across all businesses: the daily cap in
 * system_flags is one platform-wide budget (M2-00).
 */
export async function agentSpendSince(db: Db, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${agentSteps.costNanoUsd}), 0)` })
    .from(agentSteps)
    .where(gte(agentSteps.createdAt, since));
  return Number(row?.total ?? 0);
}
