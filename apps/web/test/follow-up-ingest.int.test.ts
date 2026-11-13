// M3-05 intake on Postgres over the recorded M0-04 follow-up (RFI 6ac53a86): the follow-up snapshot on an
// ANSWERED RFI opens round 2 in DRAFTING, records which question ids Airwallex reopened and which it
// appended, and a replay of the same snapshot creates no second round and no second draft job.
import { getRfi, listAudit, listRfiQuestions, listRfis, repoCtx } from "@carnet/db";
import { describe, expect, it } from "vitest";
import { memoryLogger } from "../src/server/log";
import type { HandlerContext } from "../src/worker/handlers/index";
import { ingestRfi } from "../src/worker/handlers/rfi";
import { followUpSequence, newBusiness, retarget, uid } from "./rfi-support";
import { FetchStub, makeClient, query, webTestDatabase } from "./support";

const db = webTestDatabase();

describe("round 2 intake from the recorded follow-up", () => {
  it("round 2: opens DRAFTING with the reopened and new question ids recorded; a replayed event adds no second round", async () => {
    const { businessId, accountId } = await newBusiness(db().app.db);
    const id = uid("3a3a3a3a");
    const [s1, s2, s3] = followUpSequence().map((s) => retarget(s, { id, accountId }));
    const stub = new FetchStub();
    let current = s1;
    stub.on("GET", /^\/api\/v1\/rfis\/[^/]+$/, () => Response.json(current));
    const airwallex = makeClient(stub);
    const ctx = {
      db: db().app.db,
      airwallex,
      airwallexWriter: airwallex,
      logger: memoryLogger(),
    } as unknown as HandlerContext;
    const feed = async (wire: typeof s1) => {
      current = wire;
      return ingestRfi(ctx, await airwallex.getRfi(id), "webhook");
    };
    await feed(s1);
    await feed(s2);
    const applied = await feed(s3);
    expect(applied).toMatchObject({ outcome: "applied", state: "DRAFTING", round: 2 });

    const rc = repoCtx(db().app.db, businessId);
    const [row] = await listRfis(rc);
    expect(row).toMatchObject({ state: "DRAFTING", round: 2 });
    const round2 = await listRfiQuestions(rc, row?.id as never, 2);
    expect(round2.map((q) => q.reopened)).toEqual([true, false]);

    const audit = (await listAudit(rc, 200)).find(
      (a) =>
        a.action === "rfi.transition" &&
        (a.data as { to?: string; round?: number }).to === "DRAFTING" &&
        (a.data as { round?: number }).round === 2,
    );
    expect(audit?.data).toMatchObject({
      reopenedQuestionIds: ["5f4cbf0a-ef8b-44a6-9689-247cc36caa38"],
      newQuestionIds: ["a4f64392-f2d6-4071-8c13-70c828297792"],
    });

    const jobs = () =>
      query<{ payload: { round: number } }>(
        db().appUrl,
        "SELECT payload FROM outbox_jobs WHERE kind = 'rfi.draft' ORDER BY created_at",
      );
    const before = (await jobs()).map((j) => j.payload.round);
    expect(before.filter((r) => r === 2)).toHaveLength(1);

    // The same event again (at-least-once delivery): nothing changes.
    const replay = await feed(s3);
    expect(replay.outcome).toBe("duplicate");
    expect(await listRfis(rc)).toHaveLength(1);
    expect((await getRfi(rc, row?.id as never))?.round).toBe(2);
    expect((await jobs()).map((j) => j.payload.round)).toEqual(before);
  });
});
