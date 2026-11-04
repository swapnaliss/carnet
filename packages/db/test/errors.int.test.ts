import { newPaymentId, newRequestId } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import {
  DuplicateIdempotencyKeyError,
  DuplicateRequestIdError,
  DuplicateWebhookEventError,
  UniqueViolationError,
} from "../src/errors";
import { repoCtx } from "../src/repos/context";
import { createAttempt, getAttemptByRequestId } from "../src/repos/execution-attempts";
import { saveIdempotencyRecord } from "../src/repos/idempotency-keys";
import { createBusiness, insertWebhookEvent } from "../src/repos/system";
import { useTestDatabase } from "./harness";

const db = useTestDatabase();

describe("uniqueness violations are typed errors", () => {
  it("webhook_events.provider_event_id → DuplicateWebhookEventError", async () => {
    const { app } = db();
    const event = {
      providerEventId: "evt_dup_1",
      name: "payout.transfer.processing",
      rawBody: "{}",
      signatureOk: true,
    };
    await insertWebhookEvent(app.db, event);
    const error = await insertWebhookEvent(app.db, event).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DuplicateWebhookEventError);
    expect(error).toBeInstanceOf(UniqueViolationError);
    expect(error).toMatchObject({
      providerEventId: "evt_dup_1",
      constraint: "webhook_events_provider_event_id_key",
    });
  });

  it("execution_attempts.request_id → DuplicateRequestIdError, and the first attempt is kept", async () => {
    const { app } = db();
    const ctx = repoCtx(app.db, await createBusiness(app.db, { name: "Dup Co" }));
    const requestId = newRequestId();
    const first = await createAttempt(ctx, { kind: "transfer", refId: newPaymentId(), requestId });
    const error = await createAttempt(ctx, {
      kind: "transfer",
      refId: newPaymentId(),
      requestId,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DuplicateRequestIdError);
    expect(error).toMatchObject({ requestId, constraint: "execution_attempts_request_id_key" });
    expect((await getAttemptByRequestId(ctx, requestId))?.id).toBe(first.id);
  });

  it("request_id is unique across businesses too (an Airwallex request id is global)", async () => {
    const { app } = db();
    const a = repoCtx(app.db, await createBusiness(app.db, { name: "A" }));
    const b = repoCtx(app.db, await createBusiness(app.db, { name: "B" }));
    const requestId = newRequestId();
    await createAttempt(a, { kind: "conversion", refId: newPaymentId(), requestId });
    await expect(
      createAttempt(b, { kind: "conversion", refId: newPaymentId(), requestId }),
    ).rejects.toBeInstanceOf(DuplicateRequestIdError);
  });

  it("idempotency key → DuplicateIdempotencyKeyError", async () => {
    const { app } = db();
    const ctx = repoCtx(app.db, await createBusiness(app.db, { name: "Idem Co" }));
    const record = {
      endpoint: "POST /api/v1/payments",
      key: "k-1",
      requestHash: "h",
      responseStatus: 201,
      response: { ok: true },
    };
    await saveIdempotencyRecord(ctx, record);
    await expect(saveIdempotencyRecord(ctx, record)).rejects.toBeInstanceOf(
      DuplicateIdempotencyKeyError,
    );
  });

  it("errors raised inside a transaction keep their type and roll the transaction back", async () => {
    const { app } = db();
    const event = { providerEventId: "evt_tx", name: "x", rawBody: "{}", signatureOk: true };
    await insertWebhookEvent(app.db, event);
    const error = await app.db
      .transaction(async (tx) => {
        await insertWebhookEvent(tx, { ...event, providerEventId: "evt_tx_other" });
        await insertWebhookEvent(tx, event);
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DuplicateWebhookEventError);
    const other = await app.pool.query(
      "SELECT 1 FROM webhook_events WHERE provider_event_id = 'evt_tx_other'",
    );
    expect(other.rowCount).toBe(0);
  });
});
