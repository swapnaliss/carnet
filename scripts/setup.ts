// One idempotent environment setup (M1-06). Safe to run any number of times.
//
//   npx tsx scripts/setup.ts [--roles] [--migrate]
//
//   --roles    (admin step) runs packages/db/sql/roles.sql through `psql` against DATABASE_ADMIN_URL with
//              DB_MIGRATOR_PASSWORD and DB_APP_PASSWORD (passed on stdin, never on the command line).
//              The table grants come with the migrations (0001_grants.sql, default privileges).
//   --migrate  applies pending migrations as the migration role (DATABASE_MIGRATION_URL).
//   always     seeds, as the app role (DATABASE_URL): the demo business and its placeholder
//              counterparty, then the demo users through `seedDemoUsers` (M1-04; needs the three SEED_*_PASSWORD keys).
//              Prints the row counts so two runs can be compared.
//
// In the image it is bundled to runtime/setup.mjs (`node runtime/setup.mjs`). Synthetic data only.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDbClient,
  DEMO_BUSINESS_ID,
  ensureDemoBusiness,
  MIGRATIONS_FOLDER,
  runMigrations,
  seedDemoUsers,
} from "@carnet/db";

const here = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

function log(message: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", process: "setup", message, ...extra }));
}

function need(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set`);
  return value;
}

/** First path that exists: next to the bundle (image) or in the repo. */
function locate(...candidates: string[]): string {
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`not found: ${candidates.join(", ")}`);
  return found;
}

async function applyRoles(): Promise<void> {
  const adminUrl = need("DATABASE_ADMIN_URL");
  const rolesFile = locate(
    join(here, "roles.sql"),
    join(here, "..", "packages", "db", "sql", "roles.sql"),
  );
  const quote = (v: string) => `'${v.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  const script = [
    `\\set migrator_password ${quote(need("DB_MIGRATOR_PASSWORD"))}`,
    `\\set app_password ${quote(need("DB_APP_PASSWORD"))}`,
    // The file's text on stdin (not `\i`), so a psql in a container works too.
    readFileSync(rolesFile, "utf8"),
    "",
  ].join("\n");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.PSQL ?? "psql", [adminUrl, "-q", "-v", "ON_ERROR_STOP=1"], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`psql exited ${code}`))));
    child.stdin.end(script);
  });
  log("roles applied", { file: rolesFile });
}

async function main(): Promise<void> {
  if (args.has("--roles")) await applyRoles();
  if (args.has("--migrate")) {
    const folder = locate(
      join(here, "migrations", "meta", "_journal.json"),
      join(MIGRATIONS_FOLDER, "meta", "_journal.json"),
    );
    await runMigrations(need("DATABASE_MIGRATION_URL"), dirname(dirname(folder)));
    log("migrations applied");
  }

  const client = createDbClient(need("DATABASE_URL"), { max: 2 });
  try {
    const demo = await ensureDemoBusiness(client.db);
    log("demo business ready", { businessId: demo.businessId, inserted: demo.inserted });

    // Owner, approver and read-only judge join the demo business. Aborts (naming the keys, never the
    // values) when a SEED_*_PASSWORD key is missing or shorter than 8 characters.
    const seeded = await seedDemoUsers(client.db, { businessId: DEMO_BUSINESS_ID });
    log("demo users ready", { users: seeded.users.map((u) => u.role) });

    const { rows } = await client.pool.query<{
      businesses: string;
      counterparties: string;
      users: string;
    }>(
      `SELECT (SELECT count(*) FROM businesses) AS businesses,
              (SELECT count(*) FROM counterparties) AS counterparties,
              (SELECT count(*) FROM users) AS users`,
    );
    log("row counts", { ...rows[0] });
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      process: "setup",
      message: "setup failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
