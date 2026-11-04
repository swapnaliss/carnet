// Transfers: idempotent create (ADR 0007), failure mapping, amounts as decimal strings.
import { parseMajor, type RequestId } from "@carnet/domain";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  AirwallexApiError,
  AirwallexTimeout,
  type CreateTransferInput,
  TransferWire,
} from "../src/index";
import {
  blockedCalls,
  FetchStub,
  hangUntilAborted,
  loadFixture,
  makeClient,
  toResponse,
} from "./fixture-loader";

const CREATE = "/api/v1/transfers/create";
const LIST = "/api/v1/transfers";
const recorded = loadFixture("transfer-create-local-usd");
const recordedBody = recorded.response.body as { id: string; request_id: string };

const input: CreateTransferInput = {
  requestId: recordedBody.request_id as RequestId,
  beneficiaryId: "bc0bfa01-7b09-45e3-9f2a-a3cc09eb54be",
  sourceCurrency: "USD",
  transferCurrency: "USD",
  sourceAmount: parseMajor("25", "USD"),
  transferMethod: "LOCAL",
  reason: "professional_business_services",
  reference: "M0-03 spike",
};

afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  expect(blockedCalls).toEqual([]);
});

describe("createTransfer", () => {
  it("a timed-out POST is not retried with a new request_id: it is looked up by request_id", async () => {
    vi.useFakeTimers();
    const listBody = {
      items: [loadFixture("transfer-fetch-local").response.body],
      page_after: null,
    };
    const stub = new FetchStub()
      .on("POST", CREATE, (_c, init) => hangUntilAborted(init))
      .on("GET", LIST, { status: 200, body: listBody });
    const client = makeClient(stub);
    const p = client.createTransfer(input);
    await vi.advanceTimersByTimeAsync(10_000);
    const transfer = await p;

    expect(transfer.id).toBe(recordedBody.id);
    expect(transfer.requestId).toBe(input.requestId);
    const posts = stub.calls.filter((c) => c.path === CREATE);
    expect(posts).toHaveLength(1);
    expect((posts[0]?.json as { request_id?: string } | undefined)?.request_id).toBe(
      input.requestId,
    );
    const lookups = stub.calls.filter((c) => c.path === LIST);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.url.searchParams.get("request_id")).toBe(input.requestId);
  });

  it("a timed-out POST whose transfer is not found stays UNKNOWN (AirwallexTimeout)", async () => {
    vi.useFakeTimers();
    const stub = new FetchStub()
      .on("POST", CREATE, (_c, init) => hangUntilAborted(init))
      .on("GET", LIST, { status: 200, body: { items: [] } });
    const p = makeClient(stub)
      .createTransfer(input)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBeInstanceOf(AirwallexTimeout);
    expect(stub.count("POST", CREATE)).toBe(1);
  });

  it("findTransferByRequestId ignores items with another request_id", async () => {
    const stub = new FetchStub().fixture("transfer-list");
    const client = makeClient(stub);
    expect(await client.findTransferByRequestId("not-a-recorded-request-id")).toBeNull();
    const found = await client.findTransferByRequestId(recordedBody.request_id);
    expect(found?.id).toBe(recordedBody.id);
  });

  it("duplicate_request_id returns the existing transfer (fixture transfer-reuse-request-id-same-body)", async () => {
    const stub = new FetchStub()
      .fixture("transfer-reuse-request-id-same-body")
      .fixture("transfer-fetch-local");
    const transfer = await makeClient(stub).createTransfer(input);
    expect(transfer.id).toBe("420468b9-15f0-4e07-a015-155c99b92444");
    expect(stub.count("POST", CREATE)).toBe(1);
  });

  it("omits fee_paid_by unless asked (sandbox answers fee_unknown to PAYER, BL-01)", async () => {
    const stub = new FetchStub().fixture("transfer-create-local-usd");
    await makeClient(stub).createTransfer(input);
    const sent = stub.calls.find((c) => c.path === CREATE)?.json as Record<string, unknown>;
    expect(sent).not.toHaveProperty("fee_paid_by");
    expect(sent.source_amount).toBe(25);
  });

  it("maps fee_unknown to a typed error with a clear hint (constructed from the M0-05 note)", async () => {
    const stub = new FetchStub().on("POST", CREATE, () =>
      toResponse({
        status: 400,
        body: {
          code: "fee_unknown",
          message: "There is a problem with your transfer fee configuration",
        },
      }),
    );
    const err = await makeClient(stub)
      .createTransfer({ ...input, feePaidBy: "PAYER" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AirwallexApiError);
    expect((err as AirwallexApiError).code).toBe("fee_unknown");
    expect(String(err)).toContain("omit fee_paid_by");
  });
});

describe("transfer mapping", () => {
  it("a simulated failure fetched as CANCELLED carries failure{code,type,message}", () => {
    const t = TransferWire.parse(loadFixture("transfer-fetch-failed-example").response.body);
    expect(t.status).toBe("CANCELLED");
    expect(t.failure).toEqual({
      code: "90701",
      type: "INCORRECT_ROUTING",
      message: "Account closed",
    });
  });

  it("FAILED (transition response) and PAID-then-failed are both handled", () => {
    expect(TransferWire.parse(loadFixture("transition-paid-to-failed").response.body).status).toBe(
      "FAILED",
    );
    const t = TransferWire.parse(loadFixture("transfer-fetch-paid-then-failed").response.body);
    expect(t.status).toBe("CANCELLED");
    expect(t.failure?.type).toBeTruthy();
  });

  it("a cancel without a failure code maps code to null", () => {
    const t = TransferWire.parse(loadFixture("transfer-fetch-cancelled").response.body);
    expect(t.failure).toEqual({ code: null, type: "PAYMENT_RECALLED", message: "simulation" });
  });

  it("amounts map to domain Money in minor units (SWIFT fee 13.41 on 30 EUR)", () => {
    const t = TransferWire.parse(loadFixture("transfer-create-swift-eur").response.body);
    expect(t.sourceAmount).toEqual({ minor: 3000n, currency: "EUR" });
    expect(t.fee).toEqual({ minor: 1341n, currency: "EUR" });
    expect(t.amountPayerPays).toEqual({ minor: 4341n, currency: "EUR" });
  });

  it("rejects an unknown status rather than guessing", () => {
    const body = {
      ...(loadFixture("transfer-fetch-local").response.body as object),
      status: "WEIRD",
    };
    expect(TransferWire.safeParse(body).success).toBe(false);
  });
});
