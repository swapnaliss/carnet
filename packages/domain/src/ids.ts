// Branded identifiers. Every id is a UUID string at runtime; the brand exists only in the type system
// so a PaymentId cannot be passed where an RfiId is expected. Generators use the Web Crypto global
// (no import, no I/O).

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type BusinessId = Brand<string, "BusinessId">;
export type UserId = Brand<string, "UserId">;
export type PaymentId = Brand<string, "PaymentId">;
export type CounterpartyId = Brand<string, "CounterpartyId">;
export type RfiId = Brand<string, "RfiId">;
export type AttemptId = Brand<string, "AttemptId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type RunId = Brand<string, "RunId">;
/**
 * The Airwallex `request_id`: minted once per intent (when the ExecutionAttempt is persisted) and
 * reused only to retry that same operation. After a timeout, look the object up; never mint a new one.
 */
export type RequestId = Brand<string, "RequestId">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

export const newBusinessId = (): BusinessId => uuid() as BusinessId;
export const newUserId = (): UserId => uuid() as UserId;
export const newPaymentId = (): PaymentId => uuid() as PaymentId;
export const newCounterpartyId = (): CounterpartyId => uuid() as CounterpartyId;
export const newRfiId = (): RfiId => uuid() as RfiId;
export const newAttemptId = (): AttemptId => uuid() as AttemptId;
export const newApprovalId = (): ApprovalId => uuid() as ApprovalId;
export const newRunId = (): RunId => uuid() as RunId;
export const newRequestId = (): RequestId => uuid() as RequestId;
