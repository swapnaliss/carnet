import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate";
import { getSystemFlags } from "../src/repos/system";
import { M1_TABLES, useTestDatabase, withClient } from "./harness";

const db = useTestDatabase();

async function tables(url: string): Promise<string[]> {
  return withClient(url, async (c) => {
    const r = await c.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    return r.rows.map((row) => row.table_name);
  });
}

async function appliedCount(url: string): Promise<number> {
  return withClient(url, async (c) => {
    const r = await c.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM drizzle."__drizzle_migrations"',
    );
    return Number(r.rows[0]?.n);
  });
}

describe("migrations", () => {
  it("create every M1 table on an empty database, owned by the migration role", async () => {
    const { migrationUrl } = db();
    expect(await tables(migrationUrl)).toEqual([...M1_TABLES]);
    const owners = await withClient(migrationUrl, async (c) => {
      const r = await c.query<{ tableowner: string }>(
        "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'",
      );
      return r.rows.map((row) => row.tableowner);
    });
    expect(owners).toEqual(["carnet_migrator"]);
  });

  it("are a no-op when run a second time", async () => {
    const { migrationUrl } = db();
    const before = await appliedCount(migrationUrl);
    expect(before).toBeGreaterThanOrEqual(2);
    await runMigrations(migrationUrl);
    await runMigrations(migrationUrl);
    expect(await appliedCount(migrationUrl)).toBe(before);
    expect(await tables(migrationUrl)).toEqual([...M1_TABLES]);
  });

  it("seed the single system_flags row the kill switch reads", async () => {
    const flags = await getSystemFlags(db().app.db);
    expect(flags.agentsEnabled).toBe(true);
    expect(flags.executionEnabled).toBe(true);
    expect(flags.dailySpendCap).toEqual({ minor: 1000n, currency: "USD" });
    expect(flags.perRunCap).toEqual({ minor: 100n, currency: "USD" });
  });
});
