// ADR 0013: the app role cannot alter, drop or truncate the audit log, nor update it; it can only
// append and read. It cannot create objects or alter any table.
import { describe, expect, it } from "vitest";
import { M1_TABLES, sqlStateOf, useTestDatabase, withClient } from "./harness";

const db = useTestDatabase();
const PERMISSION_DENIED = "42501";

describe("app role on audit_log", () => {
  it("connects as carnet_app, not as an owner or superuser", async () => {
    const who = await withClient(db().appUrl, async (c) => {
      const r = await c.query<{
        current_user: string;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
      }>(
        "SELECT current_user, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user",
      );
      return r.rows[0];
    });
    expect(who).toEqual({
      current_user: "carnet_app",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });

  it("INSERT and SELECT succeed", async () => {
    const { appUrl } = db();
    expect(
      await sqlStateOf(
        appUrl,
        "INSERT INTO audit_log (actor_type, action, subject) VALUES ('system', 'test.insert', 'roles')",
      ),
    ).toBeNull();
    const rows = await withClient(appUrl, async (c) => {
      const r = await c.query("SELECT action FROM audit_log WHERE subject = 'roles'");
      return r.rows;
    });
    expect(rows).toEqual([{ action: "test.insert" }]);
  });

  it.each([
    ["ALTER TABLE", "ALTER TABLE audit_log ADD COLUMN tampered text"],
    ["ALTER TABLE (drop constraint)", "ALTER TABLE audit_log DROP CONSTRAINT audit_log_pkey"],
    ["DROP TABLE", "DROP TABLE audit_log"],
    ["TRUNCATE", "TRUNCATE audit_log"],
    ["UPDATE", "UPDATE audit_log SET action = 'tampered'"],
    ["DELETE", "DELETE FROM audit_log"],
  ])("%s fails with a permission error", async (_label, sql) => {
    expect(await sqlStateOf(db().appUrl, sql)).toBe(PERMISSION_DENIED);
  });

  it("the audit row is still there and unchanged", async () => {
    const rows = await withClient(db().appUrl, async (c) => {
      const r = await c.query("SELECT action FROM audit_log WHERE subject = 'roles'");
      return r.rows;
    });
    expect(rows).toEqual([{ action: "test.insert" }]);
  });
});

describe("app role cannot create objects or alter tables", () => {
  it.each([
    ["CREATE TABLE", "CREATE TABLE app_owned (id int)"],
    ["CREATE TABLE in public", "CREATE TABLE public.app_owned (id int)"],
    ["CREATE TEMP TABLE", "CREATE TEMP TABLE app_tmp (id int)"],
    ["CREATE SCHEMA", "CREATE SCHEMA app_schema"],
    ["CREATE VIEW", "CREATE VIEW app_view AS SELECT 1"],
    ["CREATE FUNCTION", "CREATE FUNCTION app_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'"],
    ["CREATE ROLE", "CREATE ROLE app_made"],
    ["CREATE DATABASE", "CREATE DATABASE app_made"],
  ])("%s fails with a permission error", async (_label, sql) => {
    expect(await sqlStateOf(db().appUrl, sql)).toBe(PERMISSION_DENIED);
  });

  it.each(M1_TABLES.map((t) => [t]))("ALTER, DROP and TRUNCATE %s fail", async (table) => {
    const { appUrl } = db();
    expect(await sqlStateOf(appUrl, `ALTER TABLE ${table} ADD COLUMN tampered text`)).toBe(
      PERMISSION_DENIED,
    );
    expect(await sqlStateOf(appUrl, `ALTER TABLE ${table} OWNER TO carnet_app`)).toBe(
      PERMISSION_DENIED,
    );
    expect(await sqlStateOf(appUrl, `DROP TABLE ${table}`)).toBe(PERMISSION_DENIED);
    expect(await sqlStateOf(appUrl, `TRUNCATE ${table}`)).toBe(PERMISSION_DENIED);
  });

  it("holds DML on the other tables (SELECT works on each)", async () => {
    const { appUrl } = db();
    for (const table of M1_TABLES) {
      expect(await sqlStateOf(appUrl, `SELECT 1 FROM ${table} LIMIT 1`)).toBeNull();
    }
  });
});
