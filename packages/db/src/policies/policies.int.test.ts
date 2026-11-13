// M3-03 AC 1: policy version and hash. Editing a policy inserts a new version with a different hash and
// leaves the old row unchanged; an auto_approvals row always references an existing version and hash;
// the append-only tables take no UPDATE or DELETE from the app role; the day boundary is the business's.
import { describe, expect, it } from "vitest";
import { convertAction, POLICY, seedWorld, storePlan } from "../../test/executor-world";
import { sqlStateOf, useTestDatabase, withClient } from "../../test/harness";
import { ForeignKeyViolationError } from "../errors";
import {
  autoApprovedTotalToday,
  createPolicyVersion,
  getLatestPolicy,
  getPolicyVersion,
  insertAutoApproval,
} from "../repos/index";

const database = useTestDatabase({ prefix: "policies" });

describe("policy versions", () => {
  it("an edit inserts a new version with a different hash and leaves the old row unchanged", async () => {
    const w = await seedWorld(database().app.db, { policy: null });
    const v1 = await createPolicyVersion(w.ctx, POLICY);
    const before = await withClient(database().migrationUrl, (c) =>
      c.query("SELECT * FROM policies WHERE business_id = $1 AND version = 1", [w.businessId]),
    );
    const v2 = await createPolicyVersion(w.ctx, { ...POLICY, slippageBps: 150 });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v2.hash).not.toBe(v1.hash);
    expect((await getLatestPolicy(w.ctx))?.version).toBe(2);
    expect((await getPolicyVersion(w.ctx, 1))?.hash).toBe(v1.hash);
    const after = await withClient(database().migrationUrl, (c) =>
      c.query("SELECT * FROM policies WHERE business_id = $1 AND version = 1", [w.businessId]),
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("policy versions, auto-approvals and quote uses take no UPDATE or DELETE from the app role", async () => {
    const w = await seedWorld(database().app.db);
    for (const table of ["policies", "auto_approvals", "fx_quote_uses"]) {
      expect(
        await sqlStateOf(database().appUrl, `UPDATE ${table} SET business_id = business_id`),
      ).toBe("42501");
      expect(await sqlStateOf(database().appUrl, `DELETE FROM ${table}`)).toBe("42501");
    }
    expect(w.businessId).toBeTruthy();
  });
});

describe("auto_approvals", () => {
  it("always references an existing policy version and hash (foreign key)", async () => {
    const w = await seedWorld(database().app.db);
    const policy = await getLatestPolicy(w.ctx);
    const { actionIds } = await storePlan(w, [convertAction(1), convertAction(2)]);
    const row = {
      amountMinor: 999n,
      currency: "USD" as const,
      dailyTotalAfterMinor: 999n,
    };
    const ok = await insertAutoApproval(w.ctx, {
      actionId: actionIds[0] as string,
      policyVersion: policy?.version ?? 0,
      policyHash: policy?.hash ?? "",
      ...row,
    });
    expect(ok).toMatchObject({ policyVersion: 1, policyHash: policy?.hash });

    // A version that does not exist, or the right version with another hash, is refused.
    await expect(
      insertAutoApproval(w.ctx, {
        actionId: actionIds[1] as string,
        policyVersion: 9,
        policyHash: policy?.hash ?? "",
        ...row,
      }),
    ).rejects.toBeInstanceOf(ForeignKeyViolationError);
    await expect(
      insertAutoApproval(w.ctx, {
        actionId: actionIds[1] as string,
        policyVersion: 1,
        policyHash: "f".repeat(64),
        ...row,
      }),
    ).rejects.toBeInstanceOf(ForeignKeyViolationError);
  });

  it("counts today's total from the start of the business day in its own time zone (UTC stored)", async () => {
    // Asia/Tokyo is UTC+9. now = 2026-11-11T20:00Z = 05:00 on 12 Nov in Tokyo.
    const w = await seedWorld(database().app.db, { timezone: "Asia/Tokyo" });
    const policy = await getLatestPolicy(w.ctx);
    const { actionIds } = await storePlan(w, [
      convertAction(1),
      convertAction(2),
      convertAction(3),
    ]);
    const at = ["2026-11-11T14:00:00Z", "2026-11-11T16:00:00Z", "2026-11-11T19:00:00Z"];
    for (const [i, id] of actionIds.entries()) {
      await withClient(database().migrationUrl, (c) =>
        c.query(
          "INSERT INTO auto_approvals (business_id, action_id, policy_version, policy_hash, amount_minor, currency, daily_total_after_minor, created_at) VALUES ($1,$2,1,$3,100,'USD',100,$4)",
          [w.businessId, id, policy?.hash, at[i]],
        ),
      );
    }
    // 14:00Z is 23:00 on 11 Nov in Tokyo (yesterday); the other two are 12 Nov (today).
    expect(await autoApprovedTotalToday(w.ctx, "USD", new Date("2026-11-11T20:00:00Z"))).toBe(200n);
    // The same instants for a UTC business all fall on 11 Nov.
    const utc = await seedWorld(database().app.db);
    const p2 = await storePlan(utc, [convertAction(1)]);
    const utcPolicy = await getLatestPolicy(utc.ctx);
    await withClient(database().migrationUrl, (c) =>
      c.query(
        "INSERT INTO auto_approvals (business_id, action_id, policy_version, policy_hash, amount_minor, currency, daily_total_after_minor, created_at) VALUES ($1,$2,1,$3,100,'USD',100,'2026-11-11T14:00:00Z')",
        [utc.businessId, p2.actionIds[0], utcPolicy?.hash],
      ),
    );
    expect(await autoApprovedTotalToday(utc.ctx, "USD", new Date("2026-11-11T20:00:00Z"))).toBe(
      100n,
    );
    expect(await autoApprovedTotalToday(utc.ctx, "EUR", new Date("2026-11-11T20:00:00Z"))).toBe(0n);
  });
});
