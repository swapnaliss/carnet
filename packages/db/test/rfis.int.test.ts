// M2-04: the rfis / rfi_questions tables, their constraints and the repository (cross-tenant cases for
// every tenant function are in tenancy.int.test.ts).
import { type BusinessId, money, type PaymentId } from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import * as repos from "../src/repos/index";
import { useTestDatabase, withClient } from "./harness";

const db = useTestDatabase({ prefix: "rfis" });

const base = (over: Partial<repos.NewRfi> = {}): repos.NewRfi => ({
  airwallexRfiId: crypto.randomUUID(),
  type: "TRANSACTION",
  subType: "TRANSACTION_MONITORING",
  airwallexStatus: "ACTION_REQUIRED",
  airwallexUpdatedAt: new Date("2026-11-03T09:57:38Z"),
  airwallexAnsweredRequests: 0,
  state: "DRAFTING",
  round: 1,
  expiresAt: new Date("2026-11-17T09:57:38Z"),
  paymentId: null,
  orphanReason: "NO_SOURCES",
  linkedBy: null,
  sourceKey: null,
  conflict: false,
  ...over,
});

const q = (id: string, round: number, title: string): repos.NewRfiQuestion => ({
  round,
  airwallexQuestionId: id,
  position: Number(id.slice(1)),
  title: { en: title, zh: null },
  description: { en: "Spike question", zh: null },
  comment: null,
  answerType: "TEXT",
  sources: [{ id: "t-1", type: "TRANSFER" }],
  reopened: round > 1,
  needsDrafting: true,
});

let biz: BusinessId;
let payment: PaymentId;
const ctx = () => repos.repoCtx(db().app.db, biz);

beforeAll(async () => {
  biz = await repos.createBusiness(db().app.db, {
    name: "Rfis Co",
    airwallexAccountId: "acct_rfis",
  });
  payment = (
    await repos.createPayment(ctx(), {
      amount: money(4000n, "USD"),
      sourceCurrency: "USD",
      method: "LOCAL",
      reference: "rfis",
    })
  ).id;
  await repos.updatePaymentTransfer(ctx(), payment, {
    transferId: "t-rfis-1",
    transferStatus: "PROCESSING",
    transferUpdatedAt: new Date("2026-11-03T09:57:00Z"),
  });
});

describe("rfis constraints", () => {
  it("an Airwallex RFI id is unique per business", async () => {
    const id = crypto.randomUUID();
    await repos.insertRfi(ctx(), base({ airwallexRfiId: id }));
    await expect(repos.insertRfi(ctx(), base({ airwallexRfiId: id }))).rejects.toThrow();
  });

  it("linked XOR orphan: payment_id and orphan_reason are never both set or both null", async () => {
    await expect(
      repos.insertRfi(ctx(), base({ paymentId: payment, orphanReason: "NO_SOURCES" })),
    ).rejects.toThrow();
    await expect(repos.insertRfi(ctx(), base({ orphanReason: null }))).rejects.toThrow();
  });

  it("per-source guard backstop: a second open non-conflict RFI with the same key is rejected", async () => {
    const key = "TRANSFER:t-guard";
    await repos.insertRfi(ctx(), base({ sourceKey: key, orphanReason: "UNKNOWN_TRANSFER" }));
    await expect(
      repos.insertRfi(ctx(), base({ sourceKey: key, orphanReason: "UNKNOWN_TRANSFER" })),
    ).rejects.toThrow();
    // Flagged conflict, it is stored (ADR 0018 amendment 1).
    const second = await repos.insertRfi(
      ctx(),
      base({ sourceKey: key, orphanReason: "UNKNOWN_TRANSFER", conflict: true }),
    );
    expect(second.conflict).toBe(true);
    expect(
      (await repos.findOpenRfiBySourceKey(ctx(), { type: "TRANSACTION", sourceKey: key }))
        ?.conflict,
    ).toBe(false);
    // No source key: RFIs coexist.
    await repos.insertRfi(ctx(), base());
    await repos.insertRfi(ctx(), base());
  });

  it("a closed RFI frees its source key", async () => {
    const key = "TRANSFER:t-closed";
    const first = await repos.insertRfi(
      ctx(),
      base({ sourceKey: key, orphanReason: "UNKNOWN_TRANSFER" }),
    );
    await repos.updateRfi(ctx(), first.id, { state: "CLOSED", airwallexStatus: "CLOSED" });
    await repos.insertRfi(ctx(), base({ sourceKey: key, orphanReason: "UNKNOWN_TRANSFER" }));
  });

  it("rejects an unknown state", async () => {
    await withClient(db().appUrl, async (c) => {
      await expect(
        c.query("UPDATE rfis SET state = 'SENT' WHERE business_id = $1", [biz]),
      ).rejects.toThrow(/rfis_state_check/);
    });
  });
});

describe("rfi_questions", () => {
  it("are insert-only per round: a later round adds rows and never changes round 1", async () => {
    const rfi = await repos.insertRfi(ctx(), base());
    expect(
      await repos.insertRfiQuestions(ctx(), rfi.id, [
        q("q1", 1, "Purpose?"),
        q("q2", 1, "Invoice?"),
      ]),
    ).toBe(2);
    const round1 = await repos.listRfiQuestions(ctx(), rfi.id, 1);
    // Re-ingesting round 1 with different text changes nothing.
    expect(await repos.insertRfiQuestions(ctx(), rfi.id, [q("q1", 1, "CHANGED")])).toBe(0);
    expect(
      await repos.insertRfiQuestions(ctx(), rfi.id, [q("q1", 2, "Purpose?"), q("q3", 2, "New?")]),
    ).toBe(2);
    expect(await repos.listRfiQuestions(ctx(), rfi.id, 1)).toEqual(round1);
    expect(
      (await repos.listRfiQuestions(ctx(), rfi.id)).map(
        (x) => `${x.round}:${x.airwallexQuestionId}`,
      ),
    ).toEqual(["1:q1", "1:q2", "2:q1", "2:q3"]);
  });
});

describe("holding and matching lookups", () => {
  it("paymentHasHoldingRfi follows the state; paymentIdsByTransferIds maps this business only", async () => {
    const rfi = await repos.insertRfi(
      ctx(),
      base({ paymentId: payment, orphanReason: null, linkedBy: "match", state: "APPROVED" }),
    );
    expect(await repos.paymentHasHoldingRfi(ctx(), payment)).toBe(true);
    await repos.updateRfi(ctx(), rfi.id, { state: "ANSWERED" });
    expect(await repos.paymentHasHoldingRfi(ctx(), payment)).toBe(false);
    const map = await repos.paymentIdsByTransferIds(ctx(), ["t-rfis-1", "t-unknown"]);
    expect(Object.fromEntries(map)).toEqual({ "t-rfis-1": payment });
  });
});

describe("attribution and the expiring-soon check (system functions)", () => {
  it("attributes by existing row, then account, then transfer owner, then the sole business", async () => {
    const appDb = db().app.db;
    const existing = await repos.insertRfi(ctx(), base());
    expect(
      await repos.attributeRfi(appDb, {
        airwallexRfiId: existing.airwallexRfiId,
        accountId: null,
        transferIds: [],
      }),
    ).toEqual({ businessId: biz, by: "existing" });
    expect(
      await repos.attributeRfi(appDb, {
        airwallexRfiId: "new",
        accountId: "acct_rfis",
        transferIds: [],
      }),
    ).toEqual({ businessId: biz, by: "account" });
    // A second business exists from here on, so "sole" no longer applies.
    const other = await repos.createBusiness(appDb, { name: "Other" });
    expect(
      await repos.attributeRfi(appDb, {
        airwallexRfiId: "new",
        accountId: "acct_x",
        transferIds: ["t-rfis-1"],
      }),
    ).toEqual({ businessId: biz, by: "transfer" });
    expect(
      await repos.attributeRfi(appDb, {
        airwallexRfiId: "new",
        accountId: "acct_x",
        transferIds: ["t-none"],
      }),
    ).toEqual({ businessId: null, by: "none" });
    expect(other).not.toBe(biz);
  });

  it("marks RFIs within the window and clears answered ones", async () => {
    const now = new Date("2026-11-16T12:00:00Z");
    const soon = await repos.insertRfi(
      ctx(),
      base({ expiresAt: new Date("2026-11-17T09:57:38Z") }),
    );
    const later = await repos.insertRfi(
      ctx(),
      base({ expiresAt: new Date("2026-11-30T00:00:00Z") }),
    );
    await repos.refreshRfiExpiringSoon(db().app.db, now, 48 * 3600 * 1000);
    expect((await repos.getRfi(ctx(), soon.id))?.expiringSoon).toBe(true);
    expect((await repos.getRfi(ctx(), later.id))?.expiringSoon).toBe(false);
    await repos.updateRfi(ctx(), soon.id, { state: "ANSWERED" });
    await repos.refreshRfiExpiringSoon(db().app.db, now, 48 * 3600 * 1000);
    expect((await repos.getRfi(ctx(), soon.id))?.expiringSoon).toBe(false);
  });
});
