// RFIs, beneficiaries, files and the network guard, against the recorded fixtures.
import type { RequestId } from "@carnet/domain";
import { afterAll, describe, expect, it } from "vitest";
import {
  AirwallexApiError,
  AirwallexInputError,
  AirwallexTimeout,
  type BeneficiaryDetails,
  parseWebhookEvent,
  toApiError,
} from "../src/index";
import { blockedCalls, FetchStub, loadFixture, loadWebhook, makeClient } from "./fixture-loader";

afterAll(() => {
  expect(blockedCalls).toEqual([]);
});

describe("network guard", () => {
  it("the global fetch throws and records the attempt", async () => {
    await expect(
      fetch("https://api.sandbox.airwallex.com/api/v1/balances/current"),
    ).rejects.toThrow(/network blocked/);
    expect(blockedCalls).toHaveLength(1);
    blockedCalls.length = 0;
  });
});

describe("RFIs", () => {
  it("maps an open RFI: questions, answer types, TRANSFER sources (rfi-check1-fetch)", async () => {
    const stub = new FetchStub().fixture("rfi-check1-fetch");
    const rfi = await makeClient(stub).getRfi("0dd13238-ae6a-45ce-ac21-91671fbbfef7");
    expect(rfi.status).toBe("ACTION_REQUIRED");
    expect(rfi.activeRequest?.expiresAt).toBe("2026-11-17T09:57:38+0000");
    const qs = rfi.activeRequest?.questions ?? [];
    expect(qs.map((q) => q.answerType)).toEqual(["TEXT", "ATTACHMENT"]);
    expect(qs[0]?.title.en).toBe("What is the purpose of this payment?");
    expect(qs[0]?.sources).toEqual([
      { id: "258d17cc-e230-4fa1-be0d-09c5c06269c0", type: "TRANSFER" },
    ]);
    expect(qs[0]?.answer).toBeNull();
  });

  it("maps an answered RFI: no active request, the answer kept (rfi-check2-fetch-after-full)", async () => {
    const stub = new FetchStub().fixture("rfi-check2-fetch-after-full");
    const rfi = await makeClient(stub).getRfi("6ac53a86-c1ea-479f-82ef-783d3f3c50ec");
    expect(rfi.status).toBe("ANSWERED");
    expect(rfi.activeRequest).toBeNull();
    expect(rfi.answeredRequests[0]?.questions[0]?.answer).toEqual({
      type: "TEXT",
      text: "Payment for supplier invoice INV-1001",
    });
  });

  it("listRfis sends statuses/types/page_size (rfi-check1-list)", async () => {
    const stub = new FetchStub().fixture("rfi-check1-list");
    const { items } = await makeClient(stub).listRfis({
      statuses: ["ACTION_REQUIRED"],
      types: ["TRANSACTION"],
      pageSize: 10,
    });
    expect(items).toHaveLength(1);
    const q = stub.calls.find((c) => c.path === "/api/v1/rfis")?.url.searchParams;
    expect(q?.get("statuses")).toBe("ACTION_REQUIRED");
    expect(q?.get("types")).toBe("TRANSACTION");
  });

  it("respond refuses a partial answer before the network when the question ids are given", async () => {
    const stub = new FetchStub();
    const err = await makeClient(stub)
      .respondRfi({
        rfiId: "6ac53a86-c1ea-479f-82ef-783d3f3c50ec",
        activeQuestionIds: ["q1", "q2"],
        answers: [{ questionId: "q1", answer: { type: "TEXT", text: "x" } }],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AirwallexInputError);
    expect(stub.calls.filter((c) => c.path.includes("/respond"))).toHaveLength(0);
  });

  it("respond with every question answered sends the recorded body (rfi-check2-respond-full)", async () => {
    const f = loadFixture("rfi-check2-respond-full");
    const req = f.request as { questions: Array<{ id: string; answer: never }> };
    const stub = new FetchStub().fixture("rfi-check2-respond-full");
    const rfi = await makeClient(stub).respondRfi({
      rfiId: "6ac53a86-c1ea-479f-82ef-783d3f3c50ec",
      activeQuestionIds: req.questions.map((q) => q.id),
      answers: req.questions.map((q) => ({ questionId: q.id, answer: q.answer })),
    });
    expect(rfi.status).toBe("ANSWERED");
    expect(stub.calls.find((c) => c.path.endsWith("/respond"))?.json).toEqual(f.request);
  });

  it("an rfi.* webhook leads to a fetch of the RFI by data.id", async () => {
    const e = parseWebhookEvent(loadWebhook("rfi.action_required.1").body_utf8);
    const stub = new FetchStub().on("GET", `/api/v1/rfis/${e.objectId}`, {
      status: 200,
      body: { ...(loadFixture("rfi-check1-fetch").response.body as object), id: e.objectId },
    });
    const rfi = await makeClient(stub).getRfi(e.objectId ?? "");
    expect(rfi.id).toBe(e.objectId);
  });
});

describe("beneficiaries", () => {
  const us = loadFixture("beneficiary-create-us-usd-local");
  const usReq = us.request as { beneficiary: BeneficiaryDetails };

  it("a US LOCAL account without bank_account_category gets Checking (BL-01, M0-03)", async () => {
    const { bank_account_category: _drop, ...bank } = usReq.beneficiary.bank_details;
    const stub = new FetchStub().fixture("beneficiary-create-us-usd-local");
    const b = await makeClient(stub).createBeneficiary({
      requestId: "a623da01-0dc7-4ff8-804c-949965fbf3d7" as RequestId,
      nickname: "spike-us-usd",
      beneficiary: { ...usReq.beneficiary, bank_details: bank },
      transferMethods: ["LOCAL"],
    });
    const sent = stub.calls.find((c) => c.path.endsWith("/create"))?.json as {
      beneficiary: { bank_details: Record<string, string> };
    };
    expect(sent.beneficiary.bank_details.bank_account_category).toBe("Checking");
    expect(sent).toEqual(us.request);
    expect(b.id).toBe("bc0bfa01-7b09-45e3-9f2a-a3cc09eb54be");
    expect(b.bankName).toBe("JPMorgan Chase Bank, NA");
    expect(b.accountHint).toBe("7890");
  });

  it("a DE SWIFT account is sent unchanged (no category added)", async () => {
    const de = loadFixture("beneficiary-create-de-eur-swift");
    const req = de.request as {
      request_id: string;
      nickname: string;
      beneficiary: BeneficiaryDetails;
    };
    const stub = new FetchStub().fixture("beneficiary-create-de-eur-swift");
    await makeClient(stub).createBeneficiary({
      requestId: req.request_id as RequestId,
      nickname: req.nickname,
      beneficiary: req.beneficiary,
      transferMethods: ["SWIFT"],
    });
    expect(stub.calls.find((c) => c.path.endsWith("/create"))?.json).toEqual(de.request);
  });
});

describe("files", () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");

  it("uploads a PDF as multipart `file` to the files host with a bearer (rfi-check2-upload-pdf)", async () => {
    const stub = new FetchStub().fixture("rfi-check2-upload-pdf");
    const up = await makeClient(stub).uploadFile({
      filename: "invoice.pdf",
      contentType: "application/pdf",
      bytes: pdf,
    });
    expect(up.fileId).toMatch(/^[A-Za-z0-9]+$/);
    expect(up.size).toBe(193);
    const call = stub.calls.find((c) => c.path === "/api/v1/files/upload");
    expect(call?.url.host).toBe("files.sandbox.airwallex.com");
    expect(call?.headers.authorization).toMatch(/^Bearer /);
    expect((call?.form?.get("file") as File).type).toBe("application/pdf");
  });

  it.each([
    ["a 51-character name", `${"a".repeat(47)}.pdf`, "application/pdf", pdf],
    ["a PNG", "evidence.png", "application/pdf", pdf],
    ["a path", "../x.pdf", "application/pdf", pdf],
    ["wrong magic bytes", "x.pdf", "application/pdf", new Uint8Array([1, 2, 3, 4, 5])],
    ["JPEG named .pdf", "x.pdf", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff])],
  ] as const)("refuses %s before the network", async (_label, filename, contentType, bytes) => {
    const stub = new FetchStub();
    await expect(
      makeClient(stub).uploadFile({ filename, contentType, bytes }),
    ).rejects.toBeInstanceOf(AirwallexInputError);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("toApiError (domain error format)", () => {
  it("maps input, upstream and timeout errors", () => {
    expect(toApiError(new AirwallexInputError("bad"), "c-1").error.code).toBe("VALIDATION_FAILED");
    const up = toApiError(
      new AirwallexApiError({ status: 400, code: "fee_unknown", method: "POST", path: "/x" }),
      "c-2",
    );
    expect(up.error).toMatchObject({
      code: "UPSTREAM_ERROR",
      request_id: "c-2",
      details: { airwallex_status: 400, airwallex_code: "fee_unknown" },
    });
    const to = toApiError(
      new AirwallexTimeout({ method: "GET", path: "/x", timeoutMs: 10_000 }),
      "c",
    );
    expect(to.error.code).toBe("UPSTREAM_ERROR");
    expect(toApiError(new Error("x"), "c").error.code).toBe("INTERNAL");
  });
});
