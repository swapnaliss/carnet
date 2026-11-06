// Job kinds and the handler registry (ADR 0005). A handler is a plain idempotent function: it may
// run more than once for one job (a retry, or a lease that expired after a crash). Handlers that
// call a mutating Airwallex endpoint are registered with `mutating: true`; the loop reads the kill
// switch (`system_flags.execution_enabled`) before running them and defers the job when it is off.
import type { AirwallexClient } from "@carnet/airwallex";
import type { Db, OutboxJob } from "@carnet/db";
import type { Logger } from "../../server/log";

export const JOB_KIND = {
  /** `payout.transfer.*` webhook or a poll: fetch the transfer, apply it to its payment. */
  transferSync: "transfer.sync",
  /** `rfi.*` webhook: fetch the RFI and ingest it (M2-04, handlers/rfi.ts). */
  rfiSync: "rfi.sync",
  /** Every 60 s, enqueued by the loop itself, one at a time. */
  reconcile: "reconcile",
} as const;
export type JobKind = (typeof JOB_KIND)[keyof typeof JOB_KIND];

/** The read-only adapter calls the worker's handlers use. Mutating calls arrive with M1-08/M2-07. */
export type AirwallexReader = Pick<
  AirwallexClient,
  "getTransfer" | "getRfi" | "listRfis" | "findTransferByRequestId"
>;

export interface HandlerContext {
  readonly db: Db;
  readonly airwallex: AirwallexReader;
  readonly logger: Logger;
}

export type JobHandler = (payload: unknown, ctx: HandlerContext, job: OutboxJob) => Promise<void>;

export interface HandlerDefinition {
  readonly handle: JobHandler;
  /** True when the handler calls a mutating Airwallex endpoint (kill switch applies). */
  readonly mutating: boolean;
}

export type HandlerRegistry = Map<string, HandlerDefinition>;

export function createRegistry(): HandlerRegistry {
  return new Map();
}

/** Registers (or replaces) the handler for `kind`. M2-04 replaces `rfi.sync` this way. */
export function registerHandler(
  registry: HandlerRegistry,
  kind: string,
  handle: JobHandler,
  options: { mutating?: boolean } = {},
): HandlerRegistry {
  registry.set(kind, { handle, mutating: options.mutating ?? false });
  return registry;
}

/** Reads a string field of a job payload, or throws (a malformed payload goes to DEAD via retries). */
export function payloadString(payload: unknown, key: string): string {
  if (typeof payload === "object" && payload !== null && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  throw new Error(`job payload is missing ${key}`);
}

export function payloadOptionalString(payload: unknown, key: string): string | null {
  if (typeof payload === "object" && payload !== null && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}
