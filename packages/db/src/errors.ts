// Typed database errors. Repository functions translate driver errors into these, so callers branch on
// a class, never on a SQLSTATE or a constraint name.

export class DbError extends Error {
  override readonly name: string = "DbError";
}

/** A unique constraint rejected the write (SQLSTATE 23505). */
export class UniqueViolationError extends DbError {
  override readonly name: string = "UniqueViolationError";
  readonly constraint: string;
  constructor(constraint: string, message = `unique constraint ${constraint} violated`) {
    super(message);
    this.constraint = constraint;
  }
}

/** The webhook event was already stored: at-least-once delivery, so this is a duplicate to ack. */
export class DuplicateWebhookEventError extends UniqueViolationError {
  override readonly name = "DuplicateWebhookEventError";
  readonly providerEventId: string;
  constructor(providerEventId: string) {
    super(
      "webhook_events_provider_event_id_key",
      `webhook event ${providerEventId} already stored`,
    );
    this.providerEventId = providerEventId;
  }
}

/** An attempt with this request_id exists: look it up, never mint a new id (ADR 0007). */
export class DuplicateRequestIdError extends UniqueViolationError {
  override readonly name = "DuplicateRequestIdError";
  readonly requestId: string;
  constructor(requestId: string) {
    super(
      "execution_attempts_request_id_key",
      `execution attempt with request_id ${requestId} exists`,
    );
    this.requestId = requestId;
  }
}

/** An idempotency record exists for (business, endpoint, key). */
export class DuplicateIdempotencyKeyError extends UniqueViolationError {
  override readonly name = "DuplicateIdempotencyKeyError";
  readonly endpoint: string;
  readonly key: string;
  constructor(endpoint: string, key: string) {
    super("idempotency_keys_pkey", `idempotency key already recorded for ${endpoint}`);
    this.endpoint = endpoint;
    this.key = key;
  }
}

/** A referenced row does not exist in this business (SQLSTATE 23503), including cross-tenant refs. */
export class ForeignKeyViolationError extends DbError {
  override readonly name = "ForeignKeyViolationError";
  readonly constraint: string;
  constructor(constraint: string) {
    super(`foreign key ${constraint} violated`);
    this.constraint = constraint;
  }
}

/** The single system_flags row is missing; callers fail closed (kill switch on). */
export class SystemFlagsMissingError extends DbError {
  override readonly name = "SystemFlagsMissingError";
  constructor() {
    super("system_flags row 1 is missing; run the migrations");
  }
}

interface PgErrorShape {
  code?: unknown;
  constraint?: unknown;
}

/** The pg error behind a driver or Drizzle error (Drizzle wraps it in `cause`). */
export function pgErrorOf(error: unknown): { code: string; constraint: string | undefined } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth++) {
    const shape = current as PgErrorShape;
    if (typeof shape.code === "string" && /^[0-9A-Z]{5}$/.test(shape.code)) {
      return {
        code: shape.code,
        constraint: typeof shape.constraint === "string" ? shape.constraint : undefined,
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Generic translation for errors a repository does not map to a specific class. */
export function translateDbError(error: unknown): unknown {
  const pgError = pgErrorOf(error);
  if (!pgError) return error;
  if (pgError.code === "23505") return new UniqueViolationError(pgError.constraint ?? "unknown");
  if (pgError.code === "23503")
    return new ForeignKeyViolationError(pgError.constraint ?? "unknown");
  return error;
}

/** Another writer stored a different plan under the same revision number (M3-02). */
export class PlanRevisionConflictError extends DbError {
  override readonly name = "PlanRevisionConflictError";
  readonly revision: number;
  constructor(businessId: string, revision: number) {
    super(`plan revision ${revision} of business ${businessId} exists with different inputs`);
    this.revision = revision;
  }
}
