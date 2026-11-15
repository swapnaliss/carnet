// Replays every recorded call in fixtures/airwallex/ that corresponds to a wrapper: the wrapper must
// send the recorded request body and parse the recorded response (2xx) or raise the typed error with
// the recorded status and code (non-2xx). A fixture with no wrapper must be listed in NO_WRAPPER, so
// a new fixture forces a decision. No network: the fetch guard records any escaped call.
import { type Currency, parseMajor, type RequestId } from "@carnet/domain";
import { afterAll, describe, expect, it } from "vitest";
import {
  AirwallexApiError,
  AirwallexInputError,
  type CreateBeneficiaryInput,
  type CreateConversionInput,
  type CreateQuoteInput,
  type CreateTransferInput,
  type RfiAnswer,
  type SimulatedNextStatus,
  type SimulatedQuestion,
} from "../src/index";
import {
  blockedCalls,
  FetchStub,
  FIXTURE_DIR,
  type Fixture,
  fixtureNames,
  isRecordedCall,
  loadFixture,
  makeClient,
  readJson,
} from "./fixture-loader";

/** Recorded calls to endpoints the adapter has no wrapper for (out of the ticket's scope). */
const NO_WRAPPER = new Set([
  "beneficiary-schema-de-eur-swift", // POST /beneficiary_api_schemas/generate
  "beneficiary-schema-us-usd-local",
  "beneficiary-validate-bad", // POST /beneficiaries/validate
  "beneficiary-validate-us-local",
  "fx-conversion-list", // GET /fx/conversions
  "global-accounts-list", // GET /global_accounts
  "simulation-deposit-fetch", // GET /global_accounts/{id}/transactions
]);

/** Recorded calls the adapter refuses to send at all (input checks before the network). */
const CLIENT_REFUSES = new Set([
  "error-bad-json-field", // a transfer body with only request_id: no amount
  "rfi-check3-upload-png", // Carnet uploads only PDF or JPEG
  "rfi-check3-upload-txt",
]);

type Req = Record<string, unknown>;
/** A recorded wire amount (JSON number) as domain Money, via its decimal text. */
const m = (n: unknown, currency: unknown) => parseMajor(String(n), currency as Currency);
const asReq = (f: Fixture): Req =>
  f.request && typeof f.request === "object" ? (f.request as Req) : {};
const pathOf = (f: Fixture) => new URL(f.path, "https://x");
const seg = (f: Fixture, i: number) => pathOf(f).pathname.split("/")[i] ?? "";

const ALL = fixtureNames();
const RECORDED = ALL.filter((n) => isRecordedCall(readJson(`${FIXTURE_DIR}${n}.json`)));
const SUMMARIES = ALL.filter((n) => !RECORDED.includes(n));

/** The GET /transfers/{id} fixtures by transfer id (latest file name wins). */
const transferFetchById = new Map<string, string>();
for (const n of RECORDED) {
  const f = loadFixture(n);
  const m = /^\/api\/v1\/transfers\/([0-9a-f-]{36})$/.exec(pathOf(f).pathname);
  if (f.method === "GET" && m?.[1] && f.response.status === 200) transferFetchById.set(m[1], n);
}

type Invoke = (stub: FetchStub, f: Fixture) => Promise<unknown>;

function route(f: Fixture): Invoke | undefined {
  const p = pathOf(f).pathname;
  const req = asReq(f);
  const k = `${f.method} ${p}`;
  if (k === "POST /api/v1/authentication/login") return (s) => makeClient(s).tokens.token();
  if (k === "GET /api/v1/balances/current") return (s) => makeClient(s).getBalances();
  if (k === "POST /api/v1/beneficiaries/create")
    return (s) =>
      makeClient(s).createBeneficiary({
        requestId: req.request_id,
        nickname: req.nickname,
        beneficiary: req.beneficiary,
        transferMethods: req.transfer_methods,
      } as CreateBeneficiaryInput);
  if (f.method === "GET" && /^\/api\/v1\/beneficiaries\/[^/]+$/.test(p))
    return (s) => makeClient(s).getBeneficiary(seg(f, 4));
  if (k === "POST /api/v1/transfers/create")
    return (s) => {
      const details = (f.response.body as { details?: { id?: string } }).details;
      const existing = details?.id ? transferFetchById.get(details.id) : undefined;
      if (existing) s.fixture(existing);
      const input: Req = {
        requestId: req.request_id,
        beneficiaryId: req.beneficiary_id,
        sourceCurrency: req.source_currency,
        transferCurrency: req.transfer_currency,
        transferMethod: req.transfer_method,
        reason: req.reason,
        reference: req.reference,
      };
      if (req.source_amount !== undefined)
        input.sourceAmount = m(req.source_amount, req.source_currency);
      if (req.transfer_amount !== undefined)
        input.transferAmount = m(req.transfer_amount, req.transfer_currency);
      if (req.fee_paid_by !== undefined) input.feePaidBy = req.fee_paid_by;
      return makeClient(s).createTransfer(input as unknown as CreateTransferInput);
    };
  if (f.method === "GET" && /^\/api\/v1\/transfers\/[^/]+$/.test(p))
    return (s) => makeClient(s).getTransfer(seg(f, 4));
  if (k === "GET /api/v1/transfers")
    return (s) =>
      makeClient(s).listTransfers({ pageSize: Number(pathOf(f).searchParams.get("page_size")) });
  if (k === "POST /api/v1/fx/quotes/create")
    return (s) =>
      makeClient(s).createQuote({
        buyCurrency: req.buy_currency,
        sellCurrency: req.sell_currency,
        sellAmount: m(req.sell_amount, req.sell_currency),
        validity: req.validity,
      } as CreateQuoteInput);
  if (k === "POST /api/v1/fx/conversions/create")
    return (s) => {
      const input: Req = {
        requestId: req.request_id,
        buyCurrency: req.buy_currency,
        sellCurrency: req.sell_currency,
        sellAmount: m(req.sell_amount, req.sell_currency),
        reason: req.reason,
      };
      if (req.quote_id) input.quoteId = req.quote_id;
      return makeClient(s).createConversion(input as unknown as CreateConversionInput);
    };
  if (f.method === "GET" && /^\/api\/v1\/fx\/conversions\/[^/]+$/.test(p))
    return (s) => makeClient(s).getConversion(seg(f, 5));
  if (k === "GET /api/v1/fx/rates/current") {
    const q = pathOf(f).searchParams;
    return (s) =>
      makeClient(s).getCurrentRate({
        buyCurrency: q.get("buy_currency") as Currency,
        sellCurrency: q.get("sell_currency") as Currency,
        sellAmount: parseMajor(q.get("sell_amount") ?? "", q.get("sell_currency") as Currency),
      });
  }
  if (k === "GET /api/v1/rfis") {
    const q = pathOf(f).searchParams;
    return (s) =>
      makeClient(s).listRfis({
        statuses: [q.get("statuses") as "ACTION_REQUIRED"],
        types: [q.get("types") ?? ""],
        pageSize: Number(q.get("page_size")),
      });
  }
  if (f.method === "GET" && /^\/api\/v1\/rfis\/[^/]+$/.test(p))
    return (s) => makeClient(s).getRfi(seg(f, 4));
  if (f.method === "POST" && /^\/api\/v1\/rfis\/[^/]+\/respond$/.test(p))
    return (s) =>
      makeClient(s).respondRfi({
        rfiId: seg(f, 4),
        answers: (req.questions as Array<{ id: string; answer: RfiAnswer }>).map((q) => ({
          questionId: q.id,
          answer: q.answer,
        })),
      });
  if (k === "POST /api/v1/files/upload")
    return (s) => {
      const name = String((f.response.body as { filename?: string }).filename ?? "evidence.txt");
      const jpeg = /\.jpe?g$/i.test(name);
      const bytes = jpeg
        ? new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
        : new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
      return makeClient(s).uploadFile({
        filename: name,
        contentType: jpeg ? "image/jpeg" : "application/pdf",
        bytes,
      });
    };
  const toQuestion = (q: Req): SimulatedQuestion => {
    const out: SimulatedQuestion = {
      answerType: (q.answer as { type: SimulatedQuestion["answerType"] }).type,
      title: (q.title as { en: string }).en,
      description: (q.description as { en: string }).en,
    };
    if (q.sources) out.sources = q.sources as NonNullable<SimulatedQuestion["sources"]>;
    return out;
  };
  if (k === "POST /api/v1/simulation/rfis/create")
    return (s) =>
      makeClient(s).simulator.createRfi({
        type: "TRANSACTION",
        questions: (req.questions as Req[]).map(toQuestion),
      });
  if (f.method === "POST" && /^\/api\/v1\/simulation\/rfis\/[^/]+\/follow_up$/.test(p))
    return (s) => {
      const qs = req.questions as Req[];
      return makeClient(s).simulator.followUpRfi(seg(f, 5), {
        reopen: qs.filter((q) => !q.title).map((q) => String(q.id)),
        append: qs.filter((q) => q.title).map(toQuestion),
      });
    };
  if (f.method === "POST" && /^\/api\/v1\/simulation\/rfis\/[^/]+\/close$/.test(p))
    return (s) => makeClient(s).simulator.closeRfi(seg(f, 5));
  if (f.method === "POST" && /^\/api\/v1\/simulation\/transfers\/[^/]+\/transition$/.test(p))
    return (s) => {
      const id = seg(f, 5);
      const fetched = transferFetchById.get(id);
      if (fetched) s.fixture(fetched);
      else s.fixture("error-transfer-not-found");
      return makeClient(s).simulator.transitionTransfer(
        id,
        req.next_status as SimulatedNextStatus,
        req.failure_type as string | undefined,
      );
    };
  if (k === "POST /api/v1/simulation/deposit/create")
    return (s) =>
      makeClient(s).simulator.depositFunds({
        globalAccountId: String(req.global_account_id),
        amount: m(req.amount, req.currency),

        requestId: req.request_id as RequestId,
      });
  return undefined;
}

afterAll(() => {
  expect(blockedCalls).toEqual([]);
});

describe("fixture catalog", () => {
  it("classifies every recorded call: a wrapper or an explicit NO_WRAPPER entry", () => {
    const unclassified = RECORDED.filter((n) => !NO_WRAPPER.has(n) && !route(loadFixture(n)));
    expect(unclassified).toEqual([]);
    const wrongly = [...NO_WRAPPER].filter((n) => route(loadFixture(n)));
    expect(wrongly).toEqual([]);
    expect(RECORDED.length - NO_WRAPPER.size).toBeGreaterThanOrEqual(129);
    // summaries (spike notes, not HTTP calls) are not replayable
    expect(SUMMARIES.every((n) => !isRecordedCall(readJson(`${FIXTURE_DIR}${n}.json`)))).toBe(true);
  });

  const replayable = RECORDED.filter((n) => !NO_WRAPPER.has(n));
  it.each(replayable)("%s", async (name) => {
    const f = loadFixture(name);
    const invoke = route(f);
    if (!invoke) throw new Error("no route");
    const stub = new FetchStub();
    stub.on(f.method, pathOf(f).pathname, f.response);
    const isUpload = pathOf(f).pathname === "/api/v1/files/upload";
    const clientRejects = CLIENT_REFUSES.has(name);

    const outcome = await Promise.resolve()
      .then(() => invoke(stub, f))
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    expect(stub.unmatched).toEqual([]);
    const target = stub.calls.filter((c) => c.method === f.method && c.path === pathOf(f).pathname);

    if (clientRejects) {
      // refused before the network: no request reaches the stub
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toBeInstanceOf(AirwallexInputError);
      expect(target).toHaveLength(0);
      return;
    }

    expect(target.length).toBeGreaterThanOrEqual(1);
    const sent = target[0];
    if (f.request && typeof f.request === "object" && !isUpload) {
      expect(sent?.json).toEqual(f.request);
    }
    if (isUpload) {
      const file = sent?.form?.get("file");
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe((f.response.body as Req).filename);
      expect(sent?.url.origin).toBe("https://files.sandbox.airwallex.com");
    }
    if (pathOf(f).pathname.includes("/fx/")) {
      expect(sent?.headers["x-api-version"]).toBeUndefined();
    }

    const status = f.response.status;
    const body = f.response.body as Req;
    if (status >= 200 && status < 300) {
      if (!outcome.ok) throw outcome.error;
      expect(outcome.value).toBeDefined();
      return;
    }
    // non-2xx: either the typed error, or a documented recovery
    if (outcome.ok) {
      const v = outcome.value as { id?: string; transfer?: { status: string } };
      if (body.code === "duplicate_request_id") {
        expect(v.id).toBe((body.details as { id: string }).id);
        return;
      }
      if (status >= 500 && v.transfer) return; // transition applied, confirmed by fetch
      throw new Error(`expected an error for ${status}`);
    }
    expect(outcome.error).toBeInstanceOf(AirwallexApiError);
    const err = outcome.error as AirwallexApiError;
    expect(err.status).toBe(status);
    expect(err.code).toBe(body.code);
  });
});
