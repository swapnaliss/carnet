import { appendAudit, createDbClientFromEnv, repoCtx, verifyAndStoreAuditChain } from "@carnet/db";
import { expect, test } from "@playwright/test";
import { forgeLatestAction, restoreAction } from "../test/support/audit-tamper";
import { ownerPassword, signIn, withDb } from "./evidence-support";

// M4-01: the audit chain panel on /ops. The worker stores each verification; this spec appends rows
// through appendAudit, stores a check, tampers as the migration role (a privileged attacker) and
// stores another. Needs the web server, DATABASE_URL, DATABASE_MIGRATION_URL and the seeded users.
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
test.skip(
  !ownerPassword || !process.env.DATABASE_URL || !migrationUrl,
  "SEED_OWNER_PASSWORD, DATABASE_URL and DATABASE_MIGRATION_URL are not set; /ops audit e2e skipped.",
);

test("owner sees the chain intact, then broken with the tampered row id, and a non-owner is refused", async ({
  page,
}) => {
  const client = createDbClientFromEnv();
  try {
    const bizId = await withDb(
      async (c) => (await c.query<{ id: string }>("select id from businesses limit 1")).rows[0]?.id,
    );
    expect(bizId).toBeTruthy();
    const ctx = repoCtx(client.db, bizId as never);
    for (let i = 0; i < 3; i++) {
      await appendAudit(ctx, {
        actorType: "system",
        action: "e2e.audit_chain",
        subject: `e2e:${i}`,
        data: { i },
      });
    }
    const stored = await verifyAndStoreAuditChain(client.db);
    expect(stored.ok, JSON.stringify({ ...stored, firstBadId: String(stored.firstBadId) })).toBe(
      true,
    );

    await signIn(page, "owner");
    await page.goto("/ops");
    const card = page.getByRole("article", { name: "Audit chain" });
    await expect(card).toContainText("Chain intact");
    await expect(card).not.toContainText("Chain broken");

    // tamper: change one row's action without touching its hash
    const victim = await forgeLatestAction(migrationUrl as string, "e2e.audit_chain", "e2e.forged");
    try {
      await verifyAndStoreAuditChain(client.db);
      await page.goto("/ops");
      await expect(card).toContainText("Chain broken");
      await expect(card).toContainText(`First bad row ${victim}`);
    } finally {
      await restoreAction(migrationUrl as string, victim, "e2e.audit_chain");
      await verifyAndStoreAuditChain(client.db);
    }
    await page.goto("/ops");
    await expect(card).toContainText("Chain intact");

    // a non-owner role is refused
    await page.context().clearCookies();
    await signIn(page, "judge");
    const res = await page.goto("/ops");
    expect(res?.status()).toBe(403);
  } finally {
    await client.close();
  }
});
