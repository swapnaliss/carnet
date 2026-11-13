// The ONE place the audit hash is computed (ADR 0013, M4-01).
// hash = SHA-256(canonical JSON of {prev_hash, at, actor_type, actor_id, action, subject, data}).
import { createHash } from "node:crypto";

/** `prev_hash` of the first row of the chain: 64 zeros, fixed and documented. */
export const GENESIS_HASH = "0".repeat(64);

export interface AuditHashInput {
  readonly prevHash: string;
  /** Millisecond precision: the row stores exactly this instant. */
  readonly at: Date;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly subject: string;
  readonly data: unknown;
}

/** JSON with object keys sorted at every depth, so jsonb round-trips hash identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function computeAuditHash(input: AuditHashInput): string {
  const body = canonicalJson({
    prev_hash: input.prevHash,
    at: input.at.toISOString(),
    actor_type: input.actorType,
    actor_id: input.actorId,
    action: input.action,
    subject: input.subject,
    data: input.data,
  });
  return createHash("sha256").update(body, "utf8").digest("hex");
}
