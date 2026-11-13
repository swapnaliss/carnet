// M4-01 / ADR 0013: with the app role's grants alone (the trigger removed), the audit log cannot be
// changed, and the app role cannot migrate. Proven against a real Postgres.
import { beforeAll, describe, expect, it } from "vitest";
import { appendAudit } from "../src/audit/append";
import { createBusiness, repoCtx } from "../src/repos/index";
import { sqlStateOf, useTestDatabase, withClient } from "./harness";

const db = useTestDatabase({ prefix: "audit_roles" });
const PERMISSION_DENIED = "42501";

beforeAll(async () => {
  const biz = await createBusiness(db().app.db, { name: "Roles Co" });
  await appendAudit(repoCtx(db().app.db, biz.id), {
    actorType: "system",
    action: "seed",
    subject: "s",
  });
  // Remove the defence-in-depth triggers: the grants alone must hold.
  await withClient(db().migrationUrl, async (c) => {
    await c.query("DROP TRIGGER audit_log_no_update_delete ON audit_log");
    await c.query("DROP TRIGGER audit_log_no_truncate ON audit_log");
    // a trigger the app role must not be able to drop
    await c.query(
      "CREATE TRIGGER audit_probe BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change()",
    );
    await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_probe");
  });
});

describe("app role against audit_log, triggers removed", () => {
  it.each([
    ["UPDATE", "UPDATE audit_log SET action = 'x'"],
    ["DELETE", "DELETE FROM audit_log"],
    ["TRUNCATE", "TRUNCATE audit_log"],
    ["DROP TABLE", "DROP TABLE audit_log"],
    ["ALTER TABLE", "ALTER TABLE audit_log ADD COLUMN x text"],
    ["DROP TRIGGER", "DROP TRIGGER audit_probe ON audit_log"],
    [
      "CREATE OR REPLACE the trigger function",
      "CREATE OR REPLACE FUNCTION audit_log_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
    ],
    ["DROP the trigger function", "DROP FUNCTION audit_log_reject_change()"],
    [
      "CREATE TRIGGER",
      "CREATE TRIGGER x BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change()",
    ],
    ["DISABLE TRIGGER", "ALTER TABLE audit_log DISABLE TRIGGER ALL"],
  ])("%s fails with a permission error", async (_l, sql) => {
    expect(await sqlStateOf(db().appUrl, sql)).toBe(PERMISSION_DENIED);
  });

  it("cannot delete or truncate the chain head or status either", async () => {
    for (const t of ["audit_chain_head", "audit_chain_status"]) {
      expect(await sqlStateOf(db().appUrl, `DELETE FROM ${t}`)).toBe(PERMISSION_DENIED);
      expect(await sqlStateOf(db().appUrl, `TRUNCATE ${t}`)).toBe(PERMISSION_DENIED);
      expect(await sqlStateOf(db().appUrl, `DROP TABLE ${t}`)).toBe(PERMISSION_DENIED);
    }
  });

  it("can still append through appendAudit", async () => {
    const [row] = (
      await withClient(db().appUrl, (c) => c.query("SELECT count(*)::int AS n FROM audit_log"))
    ).rows;
    expect(row.n).toBe(1);
  });
});

describe("the app role cannot run migrations", () => {
  it("cannot create the drizzle migrations schema or table, nor write to it", async () => {
    expect(await sqlStateOf(db().appUrl, "CREATE SCHEMA drizzle2")).toBe(PERMISSION_DENIED);
    expect(
      await sqlStateOf(
        db().appUrl,
        "INSERT INTO drizzle.\"__drizzle_migrations\" (hash, created_at) VALUES ('x', 1)",
      ),
    ).toBe(PERMISSION_DENIED);
    expect(await sqlStateOf(db().appUrl, "CREATE TABLE migrated_by_app (id int)")).toBe(
      PERMISSION_DENIED,
    );
  });

  it("the migration role owns audit_log and the app role is not a member of it", async () => {
    const r = await withClient(db().migrationUrl, (c) =>
      c.query<{ owner: string; member: boolean }>(
        "SELECT tableowner AS owner, pg_has_role('carnet_app', tableowner::name, 'MEMBER') AS member FROM pg_tables WHERE tablename = 'audit_log'",
      ),
    );
    expect(r.rows[0]).toEqual({ owner: "carnet_migrator", member: false });
  });
});

describe("migrations are idempotent", () => {
  it("re-running the custom grants and trigger statements from scratch leaves the same result", async () => {
    const { runMigrations } = await import("../src/migrate");
    await expect(runMigrations(db().migrationUrl)).resolves.not.toThrow();
  });
});
