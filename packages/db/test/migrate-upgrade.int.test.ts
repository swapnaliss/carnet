// A database that already applied the migrations before 0007 (as the deployed one has) must pick up
// 0007_documents. Drizzle's migrator skips any migration whose journal timestamp is not later than the
// last applied one, so the journal `when` values must increase with the file order (M2-01).
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, runMigrations } from "../src/migrate";
import { withClient, withDatabase, workerKey } from "./harness";

interface Entry {
  idx: number;
  when: number;
  tag: string;
}

describe("migration journal", () => {
  it("timestamps strictly increase with the order of the files", async () => {
    const journal = JSON.parse(
      await readFile(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
    ) as {
      entries: Entry[];
    };
    for (let i = 1; i < journal.entries.length; i++) {
      const [prev, cur] = [journal.entries[i - 1], journal.entries[i]];
      expect(cur?.when, `${cur?.tag} must be later than ${prev?.tag}`).toBeGreaterThan(
        prev?.when ?? 0,
      );
    }
  });

  it("a database that already has every earlier migration gets the documents table", async () => {
    const admin = process.env.DATABASE_MIGRATION_URL;
    if (!admin) throw new Error("DATABASE_MIGRATION_URL is not set");
    const name = `carnet_test_upg_${workerKey()}`;
    const adminUrl = admin;
    const url = withDatabase(new URL(admin), name);
    const dir = await mkdtemp(join(tmpdir(), "carnet-mig-"));
    await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${name}"`));
    await withClient(adminUrl, (c) => c.query(`CREATE DATABASE "${name}"`));
    try {
      await cp(MIGRATIONS_FOLDER, dir, { recursive: true });
      const journalPath = join(dir, "meta/_journal.json");
      const full = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Entry[] };
      const at = full.entries.findIndex((e) => e.tag === "0007_documents");
      expect(at).toBeGreaterThan(0);
      // Apply everything before 0007, as the deployed database has.
      await writeFile(journalPath, JSON.stringify({ ...full, entries: full.entries.slice(0, at) }));
      await runMigrations(url, dir);
      const regclass = () =>
        withClient(
          url,
          async (c) => (await c.query("SELECT to_regclass('public.documents') AS t")).rows[0],
        );
      expect(await regclass()).toEqual({ t: null });
      // Then the real folder (what a deploy runs).
      await runMigrations(url);
      expect(await regclass()).toEqual({ t: "documents" });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${name}"`));
    }
  });
});
