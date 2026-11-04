// SandboxSimulator (ADR 0018): only real /api/v1/simulation/* endpoints, shapes from M0-03/M0-04.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMajor, type RequestId } from "@carnet/domain";
import { afterAll, describe, expect, it } from "vitest";
import { AirwallexApiError, LOGIN_PATH, transitionApplied } from "../src/index";
import { blockedCalls, FetchStub, loadFixture, makeClient } from "./fixture-loader";

const SIM = "/api/v1/simulation/";

afterAll(() => {
  expect(blockedCalls).toEqual([]);
});

describe("static: simulator.ts names only /simulation/ paths", () => {
  it("every API path literal in the implementation starts with /api/v1/simulation/", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/simulator.ts", import.meta.url)),
      "utf8",
    );
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    const literals = [...code.matchAll(/["'`](\/api\/[^"'`$]*)/g)].map((m) => m[1] ?? "");
    expect(literals.length).toBeGreaterThanOrEqual(5);
    expect(literals.filter((p) => !p.startsWith(SIM))).toEqual([]);
    // it calls no wrapper function (only schemas and types come from rfis/transfers)
    expect(code).not.toMatch(
      /\b(getTransfer|getRfi|listTransfers|createTransfer|respondRfi)\(|\bfetch\(/,
    );
  });
});

describe("runtime: every simulator call goes to /simulation/", () => {
  it("createRfi, followUpRfi, closeRfi, transitionTransfer, depositFunds", async () => {
    const stub = new FetchStub()
      .fixture("rfi-check1-create")
      .fixture("rfi-followup-reopen-and-append")
      .fixture("rfi-check5-close-open")
      .fixture("transition-swift-eur-sent")
      .fixture("simulation-deposit-create");
    const sim = makeClient(stub).simulator;
    const rfi = await sim.createRfi({
      type: "TRANSACTION",
      questions: [
        {
          answerType: "TEXT",
          title: "What is the purpose of this payment?",
          description: "Spike question",
          sources: [{ id: "258d17cc-e230-4fa1-be0d-09c5c06269c0", type: "TRANSFER" }],
        },
      ],
    });
    expect(rfi.status).toBe("ACTION_REQUIRED");
    const fu = await sim.followUpRfi("6ac53a86-c1ea-479f-82ef-783d3f3c50ec", {
      reopen: ["5f4cbf0a-ef8b-44a6-9689-247cc36caa38"],
    });
    expect(fu.activeRequest?.questions).toHaveLength(2);
    expect((await sim.closeRfi("ecb3f7b4-691a-4358-af53-bff3bec623e3")).status).toBe("CLOSED");
    const tr = await sim.transitionTransfer("cbe5d4c6-199a-4213-a707-fdd61bb23fdf", "SENT");
    expect(tr).toMatchObject({ confirmedAfterError: false, transfer: { status: "SENT" } });
    const dep = await sim.depositFunds({
      globalAccountId: "834b33f1-3b14-4cca-b4f8-e57bc67154fb",
      amount: parseMajor("1000", "HKD"),
      requestId: "547ee103-bf57-4816-8bb4-9feeca081e5a" as RequestId,
    });
    expect(dep.amount).toEqual({ minor: 100000n, currency: "HKD" });

    const paths = stub.calls.map((c) => c.path).filter((p) => p !== LOGIN_PATH);
    expect(paths).toHaveLength(5);
    expect(paths.every((p) => p.startsWith(SIM))).toBe(true);
  });
});

describe("transition errors (BL-01: a 500 can hide an applied transition)", () => {
  it("500 then a fetch showing the requested status: confirmed", async () => {
    const id = "62e8f568-ba29-41f7-ac20-22e5ba75e4bf";
    const stub = new FetchStub()
      .on(
        "POST",
        `${SIM}transfers/${id}/transition`,
        loadFixture("transition-local-usd-sent").response,
      )
      .fixture("transfer-fetch-local-usd-paid");
    const r = await makeClient(stub).simulator.transitionTransfer(id, "SENT");
    expect(r.confirmedAfterError).toBe(true);
    expect(r.transfer.status).toBe("SENT");
    expect(stub.count("GET", `/api/v1/transfers/${id}`)).toBe(1);
  });

  it("500 and the fetch shows another status: the error stands (fixture transition-processing-invalid)", async () => {
    const id = "62e8f568-ba29-41f7-ac20-22e5ba75e4bf";
    const stub = new FetchStub()
      .fixture("transition-processing-invalid")
      .fixture("transfer-fetch-local-usd-paid");
    const err = await makeClient(stub)
      .simulator.transitionTransfer(id, "PROCESSING")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AirwallexApiError);
    expect((err as AirwallexApiError).status).toBe(500);
  });

  it("a simulated FAILED reads CANCELLED when fetched and counts as applied", () => {
    expect(transitionApplied("FAILED", "CANCELLED")).toBe(true);
    expect(transitionApplied("FAILED", "FAILED")).toBe(true);
    expect(transitionApplied("SENT", "PAID")).toBe(false);
  });

  it("a 400 (rfi-oneopen-second-create-while-open) is surfaced, not confirmed", async () => {
    const stub = new FetchStub().fixture("rfi-oneopen-second-create-while-open");
    const err = await makeClient(stub)
      .simulator.createRfi({
        type: "TRANSACTION",
        questions: [{ answerType: "TEXT", title: "t", description: "d" }],
      })
      .catch((e: unknown) => e);
    expect((err as AirwallexApiError).code).toBe("invalid_state_for_operation");
  });
});
