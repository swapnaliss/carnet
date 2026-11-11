// AC: `seedDemoUsers` run twice yields exactly three users; running it with the password keys unset
// and NODE_ENV=production exits non-zero.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { verifyPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createBusiness,
  DEMO_USERS,
  SEED_DEFAULT_BUSINESS_ID,
  SEED_PASSWORD_ENV_KEYS,
  SeedConfigError,
  seedDemoUsers,
} from "../src/index";
import { authAccounts, businesses, counterparties, users } from "../src/schema/index";
import { useTestDatabase } from "./harness";

const db = useTestDatabase();
const packageRoot = join(import.meta.dirname, "..");
const tsx = join(packageRoot, "..", "..", "node_modules", ".bin", "tsx");

const passwords = () => ({
  SEED_OWNER_PASSWORD: randomBytes(12).toString("hex"),
  SEED_APPROVER_PASSWORD: randomBytes(12).toString("hex"),
  SEED_JUDGE_PASSWORD: randomBytes(12).toString("hex"),
});

/** Runs seed/run.ts in a child process with exactly `env` (plus PATH). */
function runSeed(env: Record<string, string>) {
  return spawnSync(tsx, ["src/seed/run.ts"], {
    cwd: packageRoot,
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("seedDemoUsers", () => {
  it("refuses missing or short passwords and writes nothing", async () => {
    const env = { ...passwords(), SEED_JUDGE_PASSWORD: "short" };
    delete (env as Record<string, string | undefined>).SEED_OWNER_PASSWORD;
    const error = await seedDemoUsers(db().app.db, { env }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeedConfigError);
    expect((error as SeedConfigError).keys).toEqual(["SEED_OWNER_PASSWORD", "SEED_JUDGE_PASSWORD"]);
    expect((error as Error).message).not.toContain("short");
    expect(await db().app.db.$count(users)).toBe(0);
  });

  it("run twice yields exactly three users, one business and three credential accounts", async () => {
    const first = passwords();
    const second = passwords();
    await seedDemoUsers(db().app.db, { env: first });
    const result = await seedDemoUsers(db().app.db, { env: second });

    expect(result.businessId).toBe(SEED_DEFAULT_BUSINESS_ID);
    const rows = await db().app.db.select().from(users).orderBy(users.email);
    expect(rows.map((r) => [r.email, r.role, r.businessId])).toEqual([
      ["approver@carnet.example", "approver", SEED_DEFAULT_BUSINESS_ID],
      ["judge@carnet.example", "viewer", SEED_DEFAULT_BUSINESS_ID],
      ["owner@carnet.example", "owner", SEED_DEFAULT_BUSINESS_ID],
    ]);
    expect(await db().app.db.$count(businesses)).toBe(1);
    expect(await db().app.db.$count(authAccounts)).toBe(3);

    // The judge is labelled read-only.
    const judge = rows.find((r) => r.role === "viewer");
    expect(judge?.name).toBe("Judge (read-only replay)");

    // The second run's passwords are the ones that verify (rotation), stored only as hashes.
    for (const u of DEMO_USERS) {
      const [account] = await db()
        .app.db.select({ password: authAccounts.password })
        .from(authAccounts)
        .where(eq(authAccounts.userId, u.id));
      const hash = account?.password ?? "";
      expect(hash).not.toContain(second[u.passwordKey]);
      expect(await verifyPassword({ hash, password: second[u.passwordKey] })).toBe(true);
      expect(await verifyPassword({ hash, password: first[u.passwordKey] })).toBe(false);
    }
  });
});

describe("seedDemoUsers with a caller's business", () => {
  it("joins an existing business (M1-06 ensureDemoBusiness) without renaming or duplicating it", async () => {
    const appDb = db().app.db;
    const businessId = await createBusiness(appDb, { name: "Existing demo business" });
    const env = passwords();
    for (let run = 0; run < 2; run++) {
      const result = await seedDemoUsers(appDb, { env, businessId });
      expect(result.businessId).toBe(businessId);
    }
    const rows = await appDb.select().from(users);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.businessId))).toEqual(new Set([businessId]));
    const [business] = await appDb.select().from(businesses).where(eq(businesses.id, businessId));
    expect(business?.name).toBe("Existing demo business");
  });
});

describe("seed/run.ts", () => {
  it("exits non-zero with the password keys unset and NODE_ENV=production", () => {
    const res = runSeed({ NODE_ENV: "production", DATABASE_URL: db().appUrl });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("seed aborted");
    for (const key of SEED_PASSWORD_ENV_KEYS) expect(res.stderr).toContain(key);
  });

  it("exits zero twice with the keys set, and never prints a password", () => {
    const env = { ...passwords(), NODE_ENV: "production", DATABASE_URL: db().appUrl };
    for (let run = 0; run < 2; run++) {
      const res = runSeed(env);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("3 users");
      for (const key of SEED_PASSWORD_ENV_KEYS) {
        expect(res.stdout + res.stderr).not.toContain(env[key]);
      }
    }
  });
});

describe("ensureDemoDataset (M2-09)", () => {
  it("adds the six dataset payees once, never changes anything on a re-run", async () => {
    const { ensureDemoBusiness, ensureDemoDataset, DEMO_DATASET_COUNTERPARTIES } = await import(
      "../src/index"
    );
    await ensureDemoBusiness(db().app.db);
    const before = await db().app.db.$count(counterparties);
    const first = await ensureDemoDataset(db().app.db);
    const second = await ensureDemoDataset(db().app.db);
    expect(first.inserted).toBe(DEMO_DATASET_COUNTERPARTIES.length);
    expect(second.inserted).toBe(0);
    expect(await db().app.db.$count(counterparties)).toBe(
      before + DEMO_DATASET_COUNTERPARTIES.length,
    );
  });
});
