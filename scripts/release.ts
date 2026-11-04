// Release step (M1-06): applies pending migrations as the migration role before a new version starts.
// Render runs it as the web service's preDeployCommand (`node runtime/release.mjs`); a non-zero exit
// fails the deploy and the previous version keeps serving. Drizzle applies all pending migrations in
// one transaction, so a failing migration leaves the schema unchanged.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS_FOLDER, runMigrations } from "@carnet/db";

function log(level: "info" | "error", message: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    process: "release",
    message,
    ...extra,
  });
  (level === "error" ? console.error : console.log)(line);
}

/** In the image the migrations ship next to the bundle (runtime/migrations); in the repo, packages/db. */
export function migrationsFolder(): string {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  return existsSync(join(bundled, "meta", "_journal.json")) ? bundled : MIGRATIONS_FOLDER;
}

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  log("error", "DATABASE_MIGRATION_URL is not set");
  process.exit(1);
}
const folder = migrationsFolder();
log("info", "migrations starting", { folder });
try {
  await runMigrations(url, folder);
  log("info", "migrations applied");
} catch (error) {
  // pg errors carry no credentials; print the message and SQLSTATE only.
  const e = error as {
    message?: string;
    code?: string;
    cause?: { message?: string; code?: string };
  };
  log("error", "migrations failed; release aborted", {
    error: e.cause?.message ?? e.message,
    code: e.cause?.code ?? e.code,
  });
  process.exit(1);
}
