// plan.revised (M3-03 scope 6): a new revision supersedes the previous revision's actions that are not yet
// APPROVED or EXECUTING, and a revision with a conversion queues `plan.execute`.
import {
  createBusiness,
  getStoredAction,
  insertPlanRevision,
  listStoredActions,
  repoCtx,
  transitionAction,
} from "@carnet/db";
import { type BusinessId, type Plan, type PlanAction, sha256Hex } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import { memoryLogger } from "../../src/server/log";
import { handlePlanRevised } from "../../src/worker/handlers/plan";
import { query, webTestDatabase } from "../support";

const db = webTestDatabase();

const convert = (seq: number, sell: string): PlanAction =>
  ({
    seq,
    kind: "convert",
    reason_code: "CONVERT_SHORTFALL",
    reason_facts: {},
    needs_approval: true,
    params: {
      sell_currency: "USD",
      buy_currency: "EUR",
      sell_minor: sell,
      buy_minor: "1",
      swift_fee_included_minor: "0",
      rate: "0.88",
      rate_low: "0.87",
      rate_high: "0.89",
      rate_as_of: "2026-11-11T09:00:00.000Z",
      auto_eligible: false,
      obligation_ids: [],
    },
  }) as PlanAction;

function plan(businessId: BusinessId, revision: number, actions: PlanAction[]): Plan {
  return {
    schema_version: 1,
    business_id: businessId,
    revision,
    inputs_hash: sha256Hex(`i${revision}${businessId}`),
    content_hash: sha256Hex(`c${revision}${businessId}`),
    now: "2026-11-11T09:00:00.000Z",
    policy: { version: 1, hash: sha256Hex("p") },
    held_funds_visible_in_balances: true,
    actions,
  };
}

describe("plan.revised handler", () => {
  it("supersedes unapproved actions of earlier revisions, keeps APPROVED ones, and queues plan.execute", async () => {
    const businessId = await createBusiness(db().app.db, { name: "Revised Co" });
    const rc = repoCtx(db().app.db, businessId);
    const first = await insertPlanRevision(
      rc,
      plan(businessId, 1, [convert(1, "100"), convert(2, "200")]),
      { inputs: {} },
    );
    const [proposed, approved] = (await listStoredActions(rc, first.stored.id)).map(
      (a) => a.id,
    ) as [string, string];
    await transitionAction(rc, approved, ["PROPOSED"], "APPROVED");
    await insertPlanRevision(rc, plan(businessId, 2, [convert(1, "300")]), { inputs: {} });

    const ctx = {
      db: db().app.db,
      logger: memoryLogger(),
      airwallex: {} as never,
    };
    await handlePlanRevised({ businessId, revision: 2 }, ctx, {} as never);

    expect((await getStoredAction(rc, proposed))?.state).toBe("SUPERSEDED");
    expect((await getStoredAction(rc, approved))?.state).toBe("APPROVED");
    const jobs = await query(
      db().appUrl,
      "SELECT payload FROM outbox_jobs WHERE kind = 'plan.execute'",
    );
    expect(jobs).toHaveLength(1);
  });
});
