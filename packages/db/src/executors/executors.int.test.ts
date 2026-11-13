// M3-03: the conversion and payout executors against Docker Postgres, with the REAL Airwallex client
// replaying the recorded sandbox responses (fixtures/airwallex/, packages/db/test/replay-gateway.ts).
// No network, no model. Live proof is the separate, skipped-by-default live.test.ts.
import {
  type AttemptId,
  type BusinessId,
  type Currency,
  type PlanInputsInput,
  plan,
  plannerPolicy,
} from "@carnet/domain";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approveConversion,
  approvePayout,
  convertAction,
  depsOf,
  POLICY,
  seedPayment,
  seedWorld,
  storePlan,
  type World,
} from "../../test/executor-world";
import { useTestDatabase, withClient } from "../../test/harness";
import { type ReplayClient, replayGateway } from "../../test/replay-gateway";
import {
  claimQuote,
  getApproval,
  getAutoApprovalForAction,
  getLatestPolicy,
  getStoredAction,
  listApprovalsForSubject,
  listAttemptsForRefs,
  supersedeStaleActions,
} from "../repos/index";
import {
  executeApprovedConversion,
  executeAutoConversion,
  executePayout,
  resolveConversionAttempt,
  runConversionActions,
} from "./index";

const database = useTestDatabase({ prefix: "executors" });

async function setKillSwitch(enabled: boolean): Promise<void> {
  await withClient(database().migrationUrl, (c) =>
    c.query("UPDATE system_flags SET execution_enabled = $1 WHERE id = 1", [enabled]),
  );
}
const sql = (text: string, values: unknown[] = []) =>
  withClient(database().migrationUrl, (c) => c.query(text, values));

beforeEach(async () => {
  await setKillSwitch(true);
});

const jsonOf = (call: { json: unknown } | undefined): Record<string, unknown> =>
  (call?.json ?? {}) as Record<string, unknown>;
const attemptsOf = (w: World, refId: string) => listAttemptsForRefs(w.ctx, "conversion", [refId]);
const noOutbound = (stub: { calls: { path: string }[] }) =>
  stub.calls.filter((c) => !c.path.includes("/authentication/"));

describe("auto-FX under policy", () => {
  it("executes inside the policy: AutoApproval with policy version and hash, attempt with request_id, DONE", async () => {
    const w = await seedWorld(database().app.db);
    const { client, server, stub } = replayGateway(
      {},
      { apiVersion: "2025-06-30" }, // the header is configured, yet FX calls must not carry it
    );
    const { actionIds } = await storePlan(w, [convertAction(1)]);
    const id = actionIds[0] as string;

    const r = await executeAutoConversion(depsOf(w, client), w.businessId, id);
    expect(r.outcome).toBe("confirmed");

    const policy = await getLatestPolicy(w.ctx);
    const auto = await getAutoApprovalForAction(w.ctx, id);
    expect(auto).toMatchObject({
      policyVersion: policy?.version,
      policyHash: policy?.hash,
      amountMinor: 999n,
      currency: "USD",
      dailyTotalAfterMinor: 999n,
    });
    const [attempt] = await attemptsOf(w, id);
    expect(attempt).toMatchObject({ kind: "conversion", status: "CONFIRMED" });
    const sent = server.conversionRequests[0]?.json as Record<string, unknown>;
    expect(sent.request_id).toBe(attempt?.requestId);
    expect(sent).toMatchObject({ sell_currency: "USD", buy_currency: "EUR", sell_amount: 9.99 });
    expect((await getStoredAction(w.ctx, id))?.state).toBe("DONE");

    // FX requests carry no x-api-version (balances, not FX, do carry the configured version).
    const fx = stub.calls.filter((c) => c.path.includes("/fx/"));
    expect(fx.length).toBeGreaterThanOrEqual(2);
    expect(fx.every((c) => c.headers["x-api-version"] === undefined)).toBe(true);
    expect(stub.calls.find((c) => c.path.includes("/balances/"))?.headers["x-api-version"]).toBe(
      "2025-06-30",
    );
  });

  it("DAILY_CAP: ten conversions just under the per-action limit execute, the eleventh is denied", async () => {
    const w = await seedWorld(database().app.db); // fresh day total
    const { client, server } = replayGateway();
    const { actionIds } = await storePlan(
      w,
      Array.from({ length: 11 }, (_, i) => convertAction(i + 1)),
    );
    const deps = depsOf(w, client);
    const outcomes = [];
    for (const id of actionIds) outcomes.push(await executeAutoConversion(deps, w.businessId, id));
    expect(outcomes.slice(0, 10).map((o) => o.outcome)).toEqual(Array(10).fill("confirmed"));
    expect(outcomes[10]).toMatchObject({ outcome: "denied", reason: "DAILY_CAP" });
    const last = await getStoredAction(w.ctx, actionIds[10] as string);
    expect(last).toMatchObject({ state: "PROPOSED", stateReason: "DAILY_CAP" });
    expect(await listAttemptsForRefs(w.ctx, "conversion", [actionIds[10] as string])).toHaveLength(
      0,
    );
    expect(server.conversionRequests).toHaveLength(10);
    expect(
      (await getAutoApprovalForAction(w.ctx, actionIds[9] as string))?.dailyTotalAfterMinor,
    ).toBe(9990n);
  });

  it("a floor breach, a per-action limit breach and slippage stay PROPOSED and call nothing", async () => {
    const w = await seedWorld(database().app.db);
    const floor = replayGateway({ balances: { USD: 105, EUR: 500 } }); // 10500 - 999 < floor 10000
    const slip = replayGateway({ quoteRate: 0.8 }); // -9.5% against the approved 0.884
    const { actionIds } = await storePlan(w, [
      convertAction(1),
      convertAction(2, { sell_minor: "1001" }),
      convertAction(3),
    ]);
    const [a, b, c] = actionIds as [string, string, string];

    expect(await executeAutoConversion(depsOf(w, floor.client), w.businessId, a)).toMatchObject({
      outcome: "denied",
      reason: "FLOOR_BREACH",
    });
    const ok = replayGateway();
    expect(await executeAutoConversion(depsOf(w, ok.client), w.businessId, b)).toMatchObject({
      outcome: "denied",
      reason: "PER_ACTION_LIMIT",
    });
    expect(await executeAutoConversion(depsOf(w, slip.client), w.businessId, c)).toMatchObject({
      outcome: "denied",
      reason: "SLIPPAGE",
    });
    for (const id of [a, b, c]) {
      expect((await getStoredAction(w.ctx, id))?.state).toBe("PROPOSED");
      expect(await attemptsOf(w, id)).toHaveLength(0);
      expect(await getAutoApprovalForAction(w.ctx, id)).toBeNull();
    }
    expect(floor.server.conversionRequests.length + slip.server.conversionRequests.length).toBe(0);
    expect(ok.server.quoteRequests).toHaveLength(0); // denied before a quote was asked for
    expect(slip.server.quoteRequests).toHaveLength(1);
  });

  it("without a policy nothing is auto-executed", async () => {
    const w = await seedWorld(database().app.db, { policy: null });
    const { client, stub } = replayGateway();
    const { actionIds } = await storePlan(w, [convertAction(1)]);
    expect(
      await executeAutoConversion(depsOf(w, client), w.businessId, actionIds[0] as string),
    ).toMatchObject({ outcome: "denied", reason: "NO_POLICY" });
    expect(noOutbound(stub)).toHaveLength(0);
  });

  it("quote reuse: a quote id Carnet already used is refused and a fresh quote is requested", async () => {
    const w = await seedWorld(database().app.db);
    const { client, server } = replayGateway({
      quoteIds: ["quote-reused-A", "quote-reused-A", "quote-fresh-B"],
    });
    const { actionIds } = await storePlan(w, [convertAction(1), convertAction(2)]);
    const deps = depsOf(w, client);
    expect((await executeAutoConversion(deps, w.businessId, actionIds[0] as string)).outcome).toBe(
      "confirmed",
    );
    // The second execution is handed "quote-reused" again: refused, so another quote is requested.
    expect((await executeAutoConversion(deps, w.businessId, actionIds[1] as string)).outcome).toBe(
      "confirmed",
    );
    expect(server.quoteRequests).toHaveLength(3);
    const used = server.conversionRequests.map((c) => (c.json as { quote_id: string }).quote_id);
    expect(used).toEqual(["quote-reused-A", "quote-fresh-B"]);
    expect(
      await claimQuote(w.ctx, {
        quoteId: "quote-fresh-B",
        actionId: actionIds[0] as string,
        attemptId: crypto.randomUUID(),
      }),
    ).toBe(false);
  });

  it("the conversion amount includes the SWIFT fee read from config: change the config and the amount changes", async () => {
    const big = {
      ...POLICY,
      perActionLimit: [{ currency: "USD" as const, minor: "100000000" }],
      dailyCap: [{ currency: "USD" as const, minor: "1000000000" }],
    };
    const sells: bigint[] = [];
    for (const feeMinor of [1341, 2000]) {
      const w = await seedWorld(database().app.db, { policy: big });
      const policy = await getLatestPolicy(w.ctx);
      if (!policy) throw new Error("no policy");
      const planned = plan(plannerInputs(w.businessId, feeMinor, plannerPolicy(policy)));
      const action = planned.actions.find((a) => a.kind === "convert");
      expect(action?.kind).toBe("convert");
      const { client, server } = replayGateway({ balances: { USD: 1_000_000, EUR: 0 } });
      const { actionIds } = await storePlan(w, [action as never]);
      const deps = depsOf(w, client, {
        swiftPayoutFeeMinor: (c: Currency) => (c === "EUR" ? BigInt(feeMinor) : 0n),
      });
      const r = await executeAutoConversion(deps, w.businessId, actionIds[0] as string);
      expect(r.outcome).toBe("confirmed");
      const planSell = BigInt((action as { params: { sell_minor: string } }).params.sell_minor);
      expect(jsonOf(server.quoteRequests[0]).sell_amount).toBe(Number(planSell) / 100);
      expect(
        (action as { params: { swift_fee_included_minor: string } }).params
          .swift_fee_included_minor,
      ).toBe(String(feeMinor));
      sells.push(planSell);
    }
    expect(sells[1]).toBeGreaterThan(sells[0] as bigint);
  });
});

function plannerInputs(
  businessId: BusinessId,
  feeMinor: number,
  policy: ReturnType<typeof plannerPolicy>,
): PlanInputsInput {
  return {
    businessId,
    now: "2026-11-11T09:00:00.000Z",
    balances: [
      { businessId, currency: "USD", availableMinor: 100_000_000n },
      { businessId, currency: "EUR", availableMinor: 0n },
    ],
    held: [],
    obligations: [
      {
        businessId,
        id: "ob-1",
        payee: "Northwind GmbH",
        amountMinor: 1_000_000n,
        currency: "EUR",
        dueAt: "2026-11-20T00:00:00.000Z",
        criticality: 1,
        paymentId: null,
        payoutMethod: "SWIFT",
      },
    ],
    reserveFloor: [],
    config: {
      swiftPayoutFee: [{ currency: "EUR", minor: BigInt(feeMinor) }],
      fxSpreadBps: 50,
      heldFundsVisibleInBalances: true,
      deferGraceDays: { "2": 7, "3": 14 },
    },
    fxRates: [{ sell: "USD", buy: "EUR", rate: "0.884", asOf: "2026-11-11T08:59:00.000Z" }],
    policy,
  };
}

describe("attempts, UNKNOWN and lookup", () => {
  it("writes the attempt with its request_id before the outbound call; a failing client leaves the row", async () => {
    const w = await seedWorld(database().app.db);
    const { client } = replayGateway();
    const { actionIds } = await storePlan(w, [convertAction(1)]);
    const id = actionIds[0] as string;
    let seenAtCall: { status: string; requestId: string } | null = null;
    const gateway = {
      getBalances: () => client.getBalances(),
      createQuote: (i: Parameters<ReplayClient["createQuote"]>[0]) => client.createQuote(i),
      findConversionByRequestId: (r: string) => client.findConversionByRequestId(r),
      getBeneficiary: (b: string) => client.getBeneficiary(b),
      createTransfer: (i: Parameters<ReplayClient["createTransfer"]>[0]) =>
        client.createTransfer(i),
      createConversion: async (i: { requestId: string }) => {
        const [row] = await listAttemptsForRefs(w.ctx, "conversion", [id]);
        seenAtCall = { status: row?.status ?? "none", requestId: row?.requestId ?? "" };
        expect(i.requestId).toBe(row?.requestId);
        throw new Error("connection reset"); // the client throws
      },
    };
    const r = await executeAutoConversion(
      { ...depsOf(w, client), gateway: gateway as never },
      w.businessId,
      id,
    );
    expect(seenAtCall).toMatchObject({ status: "SENT_TO_AIRWALLEX" });
    expect(r.outcome).toBe("unknown");
    const [row] = await listAttemptsForRefs(w.ctx, "conversion", [id]);
    expect(row).toMatchObject({ status: "UNKNOWN", requestId: seenAtCall?.["requestId"] });
  });

  it("UNKNOWN after a timeout is resolved by lookup as CONFIRMED, with no new request_id and no second conversion", async () => {
    const w = await seedWorld(database().app.db);
    const { client, server } = replayGateway({ conversionMode: "lost" });
    const { actionIds } = await storePlan(w, [convertAction(1)]);
    const id = actionIds[0] as string;
    const deps = depsOf(w, client);
    const r = await executeAutoConversion(deps, w.businessId, id);
    expect(r.outcome).toBe("unknown");
    const [unknown] = await attemptsOf(w, id);
    expect(unknown?.status).toBe("UNKNOWN");
    expect((await getStoredAction(w.ctx, id))?.state).toBe("EXECUTING");

    const before = server.conversionRequests.length;
    const res = await resolveConversionAttempt(deps, {
      businessId: w.businessId,
      attemptId: unknown?.id as AttemptId,
    });
    expect(res.resolution).toBe("confirmed");
    expect(server.conversionRequests).toHaveLength(before); // lookup only
    const rows = await attemptsOf(w, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "CONFIRMED", requestId: unknown?.requestId });
    expect(server.conversions.size).toBe(1);
    expect((await getStoredAction(w.ctx, id))?.state).toBe("DONE");
  });

  it("UNKNOWN that lookup does not find stays UNKNOWN, then the SAME request_id is re-sent and a 4xx ends it REJECTED", async () => {
    const w = await seedWorld(database().app.db);
    const { client, server } = replayGateway({ conversionMode: "dropped" });
    const { actionIds } = await storePlan(w, [convertAction(1)]);
    const id = actionIds[0] as string;
    const deps = depsOf(w, client);
    expect((await executeAutoConversion(deps, w.businessId, id)).outcome).toBe("unknown");
    const [unknown] = await attemptsOf(w, id);
    const input = { businessId: w.businessId, attemptId: unknown?.id as AttemptId };

    // Not found, and too soon to re-send: still UNKNOWN, nothing new sent.
    const sentBefore = server.conversionRequests.length;
    expect(await resolveConversionAttempt(deps, { ...input, retryAfterMs: 3_600_000 })).toEqual({
      resolution: "unresolved",
    });
    expect(server.conversionRequests).toHaveLength(sentBefore);

    server.conversionMode = "reject";
    expect(await resolveConversionAttempt(deps, { ...input, retryAfterMs: 0 })).toEqual({
      resolution: "rejected",
    });
    const requestIds = new Set(
      server.conversionRequests.map((c) => (c.json as { request_id: string }).request_id),
    );
    expect([...requestIds]).toEqual([unknown?.requestId]); // never a new id for the same intent
    expect((await attemptsOf(w, id))[0]?.status).toBe("REJECTED");
    expect((await getStoredAction(w.ctx, id))?.state).toBe("FAILED");
  });
});

describe("kill switch", () => {
  it("kill switch off: neither a conversion nor a payout writes an attempt or calls Airwallex", async () => {
    const w = await seedWorld(database().app.db);
    const { client, stub, server } = replayGateway();
    const { actionIds } = await storePlan(w, [convertAction(1)]);
    const pay = await seedPayment(w);
    const approval = await approvePayout(w, client, pay.paymentId);
    const callsBefore = noOutbound(stub).length;

    await setKillSwitch(false);
    const deps = depsOf(w, client);
    expect(await executeAutoConversion(deps, w.businessId, actionIds[0] as string)).toEqual({
      outcome: "skipped",
      reason: "KILL_SWITCH",
    });
    expect(await executePayout(deps, w.businessId, approval)).toEqual({
      outcome: "skipped",
      reason: "KILL_SWITCH",
    });
    expect(noOutbound(stub)).toHaveLength(callsBefore);
    expect(server.conversionRequests.length + server.transferRequests.length).toBe(0);
    expect(await attemptsOf(w, actionIds[0] as string)).toHaveLength(0);
    expect(await listAttemptsForRefs(w.ctx, "transfer", [pay.paymentId])).toHaveLength(0);
    // The payout approval is untouched and usable once the switch is back on.
    expect((await getApproval(w.ctx, approval.approvalId))?.status).toBe("APPROVED");
  });

  it("kill switch turned off after the attempt is written: nothing is sent, and the same attempt resumes later", async () => {
    const w = await seedWorld(database().app.db);
    const { client, server } = replayGateway();
    const { actionIds } = await storePlan(w, [convertAction(1)]);
    const id = actionIds[0] as string;
    const gateway = {
      getBalances: () => client.getBalances(),
      createQuote: async (i: Parameters<ReplayClient["createQuote"]>[0]) => {
        const q = await client.createQuote(i);
        await setKillSwitch(false); // flips while the executor is between quote and attempt
        return q;
      },
      createConversion: (i: Parameters<ReplayClient["createConversion"]>[0]) =>
        client.createConversion(i),
      findConversionByRequestId: (r: string) => client.findConversionByRequestId(r),
      getBeneficiary: (b: string) => client.getBeneficiary(b),
      createTransfer: (i: Parameters<ReplayClient["createTransfer"]>[0]) =>
        client.createTransfer(i),
    };
    const r = await executeAutoConversion(
      { ...depsOf(w, client), gateway: gateway as never },
      w.businessId,
      id,
    );
    expect(r).toEqual({ outcome: "skipped", reason: "KILL_SWITCH" });
    expect(server.conversionRequests).toHaveLength(0);
    const [held] = await attemptsOf(w, id);
    expect(held?.status).toBe("INTENT");

    await setKillSwitch(true);
    const again = await executeAutoConversion(depsOf(w, client), w.businessId, id);
    expect(again.outcome).toBe("confirmed");
    expect(await attemptsOf(w, id)).toHaveLength(1);
    expect(jsonOf(server.conversionRequests[0]).request_id).toBe(held?.requestId);
  });
});

describe("conversion outside policy needs a bound approval", () => {
  it("executes through the same executor after the approval is consumed; a second consume is refused", async () => {
    const w = await seedWorld(database().app.db);
    const { client, server } = replayGateway();
    // 5000 minor is above the per-action limit (1000): auto-FX denies it.
    const { actionIds } = await storePlan(w, [
      convertAction(1, { sell_minor: "5000", buy_minor: "4420" }),
    ]);
    const id = actionIds[0] as string;
    const deps = depsOf(w, client);
    expect(await executeAutoConversion(deps, w.businessId, id)).toMatchObject({
      outcome: "denied",
      reason: "PER_ACTION_LIMIT",
    });

    const approval = await approveConversion(w, id);
    const r = await executeApprovedConversion(deps, w.businessId, approval);
    expect(r.outcome).toBe("confirmed");
    expect((await getApproval(w.ctx, approval.approvalId))?.status).toBe("CONSUMED");
    expect(await getAutoApprovalForAction(w.ctx, id)).toBeNull(); // approved by a person, not by policy
    const [attempt] = await attemptsOf(w, id);
    expect(attempt).toMatchObject({ kind: "conversion", status: "CONFIRMED" });
    expect((await getStoredAction(w.ctx, id))?.state).toBe("DONE");

    expect(await executeApprovedConversion(deps, w.businessId, approval)).toMatchObject({
      outcome: "refused",
      reason: "NOT_APPROVED",
    });
    expect(server.conversionRequests).toHaveLength(1);
  });

  it("refuses when the stored content no longer matches the hash, and when the fresh rate leaves the approved bounds", async () => {
    const w = await seedWorld(database().app.db);
    const tampered = replayGateway();
    const outOfBounds = replayGateway({ quoteRate: 0.95 }); // above rate_high 0.8884
    const { actionIds } = await storePlan(w, [
      convertAction(1, { sell_minor: "5000", buy_minor: "4420" }),
      convertAction(2, { sell_minor: "5000", buy_minor: "4420" }),
    ]);
    const [a, b] = actionIds as [string, string];

    const ap = await approveConversion(w, a);
    await sql(
      "UPDATE plan_actions SET params = jsonb_set(params, '{sell_minor}', '\"5001\"') WHERE id = $1",
      [a],
    );
    expect(
      await executeApprovedConversion(depsOf(w, tampered.client), w.businessId, ap),
    ).toMatchObject({
      outcome: "refused",
      reason: "HASH_MISMATCH",
    });
    expect(tampered.server.conversionRequests).toHaveLength(0);
    expect((await attemptsOf(w, a))[0]?.status).toBe("REJECTED");

    const bp = await approveConversion(w, b);
    expect(
      await executeApprovedConversion(depsOf(w, outOfBounds.client), w.businessId, bp),
    ).toMatchObject({
      outcome: "refused",
      reason: "RATE_OUT_OF_BOUNDS",
    });
    expect(outOfBounds.server.conversionRequests).toHaveLength(0);
  });
});

describe("plan revisions", () => {
  it("a new revision supersedes PROPOSED actions and ends their approvals; an approval whose content left the plan cannot be consumed", async () => {
    const w = await seedWorld(database().app.db);
    const { client, server } = replayGateway();
    const rev1 = await storePlan(w, [
      convertAction(1, { sell_minor: "5000", buy_minor: "4420" }),
      convertAction(2, { sell_minor: "6000", buy_minor: "5300" }),
      convertAction(3, { sell_minor: "7000", buy_minor: "6180" }),
    ]);
    const [kept, dropped, proposed] = rev1.actionIds as [string, string, string];
    const keptApproval = await approveConversion(w, kept);
    const droppedApproval = await approveConversion(w, dropped);
    // `proposed` has an approval row but was never marked APPROVED (only PROPOSED)
    const { approvalId } = await approveConversion(w, proposed);
    await sql("DELETE FROM plan_action_states WHERE action_id = $1", [proposed]);

    // Revision 2 keeps the content of the first action and replaces the other two.
    const rev2 = await storePlan(
      w,
      [
        convertAction(1, { sell_minor: "5000", buy_minor: "4420" }),
        convertAction(2, { sell_minor: "8000", buy_minor: "7070" }),
      ],
      2,
    );
    const superseded = await supersedeStaleActions(w.ctx, rev2.planId);
    expect(superseded).toEqual([proposed]); // APPROVED actions are not superseded
    expect((await getStoredAction(w.ctx, proposed))?.state).toBe("SUPERSEDED");
    expect(await getApproval(w.ctx, approvalId)).toMatchObject({
      status: "REJECTED",
      endReason: "SUPERSEDED",
    });

    const deps = depsOf(w, client);
    // The APPROVED action whose content is no longer in the plan: its approval cannot be consumed.
    expect(await executeApprovedConversion(deps, w.businessId, droppedApproval)).toMatchObject({
      outcome: "refused",
      reason: "SUPERSEDED",
    });
    expect((await listApprovalsForSubject(w.ctx, "conversion", dropped))[0]?.status).toBe(
      "REJECTED",
    );
    // The one the new revision kept is still executable.
    expect((await executeApprovedConversion(deps, w.businessId, keptApproval)).outcome).toBe(
      "confirmed",
    );
    expect(server.conversionRequests).toHaveLength(1);
  });
});

describe("partial plan execution and crash recovery", () => {
  it("a crash after action 1 of 3 resumes with action 2 and never re-sends action 1", async () => {
    const w = await seedWorld(database().app.db);
    const { client, server } = replayGateway();
    const { planId, actionIds } = await storePlan(w, [
      convertAction(1),
      convertAction(2),
      convertAction(3),
    ]);
    const deps = depsOf(w, client);

    await expect(
      runConversionActions(deps, w.businessId, planId, {
        afterAction: (r) => {
          if (r.seq === 1) throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    expect(server.conversionRequests).toHaveLength(1);
    expect((await getStoredAction(w.ctx, actionIds[0] as string))?.state).toBe("DONE");

    const resumed = await runConversionActions(deps, w.businessId, planId);
    expect(resumed.results.map((r) => r.seq)).toEqual([2, 3]);
    expect(resumed.blocked).toBe(false);
    const ids = server.conversionRequests.map((c) => (c.json as { request_id: string }).request_id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3); // each action has its own attempt, none was re-sent
    expect(server.conversions.size).toBe(3);
  });

  it("a crash after the call went out is resolved by lookup, not re-sent, and an unresolved UNKNOWN stops the plan", async () => {
    const w = await seedWorld(database().app.db);
    const { client, server } = replayGateway({ conversionMode: "lost" });
    const { planId, actionIds } = await storePlan(w, [convertAction(1), convertAction(2)]);
    const deps = depsOf(w, client);

    // Action 1: the answer was lost (UNKNOWN); the process "crashed" leaving SENT_TO_AIRWALLEX.
    const first = await executeAutoConversion(deps, w.businessId, actionIds[0] as string);
    expect(first.outcome).toBe("unknown");
    await sql("UPDATE execution_attempts SET status = 'SENT_TO_AIRWALLEX' WHERE ref_id = $1", [
      actionIds[0],
    ]);
    const sentBefore = server.conversionRequests.length;
    server.conversionMode = "ok"; // Airwallex answers normally from here

    const run = await runConversionActions(deps, w.businessId, planId);
    expect(run.blocked).toBe(false);
    expect(
      server.conversionRequests
        .slice(sentBefore)
        .map((c) => (c.json as { request_id: string }).request_id),
    ).not.toContain((await attemptsOf(w, actionIds[0] as string))[0]?.requestId);
    expect((await attemptsOf(w, actionIds[0] as string))[0]?.status).toBe("CONFIRMED");
    expect(run.results.map((r) => r.seq)).toEqual([1, 2]);

    // A second plan where the first action's outcome cannot be found: the next action never starts.
    const w2 = await seedWorld(database().app.db);
    const dropped = replayGateway({ conversionMode: "dropped" });
    const p2 = await storePlan(w2, [convertAction(1), convertAction(2)]);
    const d2 = depsOf(w2, dropped.client);
    const blocked = await runConversionActions(d2, w2.businessId, p2.planId, {
      retryAfterMs: 3_600_000,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.results).toHaveLength(1);
    expect(
      await listAttemptsForRefs(w2.ctx, "conversion", [p2.actionIds[1] as string]),
    ).toHaveLength(0);
  });
});

describe("payout executor", () => {
  it("executes after a bound approval: approval consumed with the attempt, request_id on the transfer, CONFIRMED", async () => {
    const w = await seedWorld(database().app.db);
    const { client, server } = replayGateway();
    const pay = await seedPayment(w);
    const approval = await approvePayout(w, client, pay.paymentId);
    const seen: string[] = [];
    const r = await executePayout(
      { ...depsOf(w, client), onTransfer: async (t: { id: string }) => void seen.push(t.id) },
      w.businessId,
      approval,
    );
    expect(r.outcome).toBe("confirmed");
    const [attempt] = await listAttemptsForRefs(w.ctx, "transfer", [pay.paymentId]);
    expect(attempt).toMatchObject({ status: "CONFIRMED" });
    const sent = server.transferRequests[0]?.json as Record<string, unknown>;
    expect(sent).toMatchObject({
      request_id: attempt?.requestId,
      transfer_method: "LOCAL",
      source_currency: "USD",
      source_amount: 25,
      reference: "INV-2026-1001",
    });
    expect(sent.fee_paid_by).toBeUndefined();
    expect((await getApproval(w.ctx, approval.approvalId))?.status).toBe("CONSUMED");
    expect(seen).toHaveLength(1);

    // An approval consumed twice is refused; nothing is sent twice.
    expect(await executePayout(depsOf(w, client), w.businessId, approval)).toMatchObject({
      outcome: "refused",
      reason: "NOT_APPROVED",
    });
    expect(server.transferRequests).toHaveLength(1);
  });

  const MUTATIONS: [
    string,
    (
      w: World,
      paymentId: string,
      s: ReturnType<typeof replayGateway>["server"],
    ) => Promise<unknown> | void,
  ][] = [
    [
      "source account",
      (w) =>
        sql("UPDATE businesses SET airwallex_account_id = 'acct_other' WHERE id = $1", [
          w.businessId,
        ]),
    ],
    [
      "source currency",
      (_w, p) => sql("UPDATE payments SET source_currency = 'EUR' WHERE id = $1", [p]),
    ],
    [
      "beneficiary fingerprint",
      (_w, _p, s) => {
        s.beneficiaryAccount = "9999999999";
      },
    ],
    ["amount", (_w, p) => sql("UPDATE payments SET amount_minor = 2501 WHERE id = $1", [p])],
    ["currency", (_w, p) => sql("UPDATE payments SET currency = 'EUR' WHERE id = $1", [p])],
    ["fee option", (_w, p) => sql("UPDATE payments SET fee_option = 'PAYER' WHERE id = $1", [p])],
    [
      "value date",
      (_w, p) => sql("UPDATE payments SET value_date = '2026-12-01' WHERE id = $1", [p]),
    ],
    [
      "reference",
      (_w, p) => sql("UPDATE payments SET reference = 'INV-2026-1002' WHERE id = $1", [p]),
    ],
    [
      "counterparty",
      async (w, p) => {
        const other = await sql(
          "INSERT INTO counterparties (business_id, name, country, beneficiary_id) VALUES ($1, 'Other LLC', 'US', 'bc0bfa01-7b09-45e3-9f2a-a3cc09eb54be') RETURNING id",
          [w.businessId],
        );
        await sql("UPDATE payments SET counterparty_id = $2 WHERE id = $1", [p, other.rows[0].id]);
      },
    ],
  ];

  it.each(MUTATIONS)(
    "changing the %s after approval makes the executor refuse and send nothing",
    async (_field, mutate) => {
      const w = await seedWorld(database().app.db);
      const rg = replayGateway();
      const pay = await seedPayment(w);
      const approval = await approvePayout(w, rg.client, pay.paymentId);
      await mutate(w, pay.paymentId, rg.server);

      const r = await executePayout(depsOf(w, rg.client), w.businessId, approval);
      expect(r).toMatchObject({ outcome: "refused", reason: "HASH_MISMATCH" });
      expect(rg.server.transferRequests).toHaveLength(0);
      const [attempt] = await listAttemptsForRefs(w.ctx, "transfer", [pay.paymentId]);
      expect(attempt?.status).toBe("REJECTED");
    },
  );

  it("refuses when the balance cannot cover the payout, and records UNKNOWN when the answer is lost", async () => {
    const w = await seedWorld(database().app.db);
    const poor = replayGateway({ balances: { USD: 1 } });
    const pay = await seedPayment(w);
    const approval = await approvePayout(w, poor.client, pay.paymentId);
    expect(await executePayout(depsOf(w, poor.client), w.businessId, approval)).toMatchObject({
      outcome: "refused",
      reason: "INSUFFICIENT_BALANCE",
    });
    expect(poor.server.transferRequests).toHaveLength(0);

    const lost = replayGateway({ transferMode: "lost" });
    const pay2 = await seedPayment(w);
    const approval2 = await approvePayout(w, lost.client, pay2.paymentId);
    const r = await executePayout(depsOf(w, lost.client), w.businessId, approval2);
    expect(r.outcome).toBe("unknown");
    const [attempt] = await listAttemptsForRefs(w.ctx, "transfer", [pay2.paymentId]);
    expect(attempt).toMatchObject({ status: "UNKNOWN" });
    expect(jsonOf(lost.server.transferRequests[0]).request_id).toBe(attempt?.requestId);
  });
});
