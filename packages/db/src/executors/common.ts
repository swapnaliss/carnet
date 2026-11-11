// Shared by the executors (M3-03).
import type { Currency } from "@carnet/domain";
import type { Db } from "../client";
import { SystemFlagsMissingError } from "../errors";
import { getSystemFlags } from "../repos/system";
import type { ExecutionGateway, GatewayTransfer } from "./gateway";

export interface ExecLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export const silentLogger: ExecLogger = { info() {}, warn() {}, error() {} };

export interface ExecutorDeps<T extends GatewayTransfer = GatewayTransfer> {
  readonly db: Db;
  readonly gateway: ExecutionGateway<T>;
  readonly now?: () => Date;
  readonly logger?: ExecLogger;
  /** The planner's flat SWIFT fee for a currency (config/fees.json), in minor units; 0 when none. */
  readonly swiftPayoutFeeMinor?: (currency: Currency) => bigint;
}

export const nowOf = (deps: Pick<ExecutorDeps, "now">): Date => (deps.now ?? (() => new Date()))();
export const loggerOf = (deps: Pick<ExecutorDeps, "logger">): ExecLogger =>
  deps.logger ?? silentLogger;

/** The kill switch (`EXECUTION_ENABLED`, system_flags). A missing row counts as off (fail closed). */
export async function executionEnabled(db: Db): Promise<boolean> {
  try {
    return (await getSystemFlags(db)).executionEnabled;
  } catch (error) {
    if (error instanceof SystemFlagsMissingError) return false;
    throw error;
  }
}

/** Thrown inside a transaction to roll it back with a reason (nothing in it is kept). */
export class Rollback extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`rollback: ${reason}`);
    this.name = "Rollback";
    this.reason = reason;
  }
}

/** What an attempt's `response` holds. Timestamps are ISO strings. */
export interface AttemptRecord {
  readonly leaseUntil?: string;
  readonly sentAt?: string;
  readonly sends?: number;
  readonly quoteId?: string;
  readonly policyVersion?: number;
  readonly policyHash?: string;
  readonly approvalId?: string;
  readonly hash?: string;
  readonly conversionId?: string;
  readonly transferId?: string;
  readonly status?: string;
  readonly confirmedAt?: string;
  readonly resolvedBy?: string;
  readonly refusal?: string;
  readonly error?: { readonly kind: string; readonly code?: string; readonly message: string };
}

export function recordOf(attempt: { response: unknown }): AttemptRecord {
  const r = attempt.response;
  return typeof r === "object" && r !== null ? (r as AttemptRecord) : {};
}

/** A record without its lease (a resolved attempt holds none). */
export function withoutLease(record: AttemptRecord): AttemptRecord {
  const { leaseUntil: _drop, ...rest } = record;
  return rest;
}

/** One executor at a time: how long a claim lasts. A crashed executor's lease lapses. */
export const EXECUTOR_LEASE_MS = 120_000;
