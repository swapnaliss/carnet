// Programmatic migrations (the test harness and deploy code). `npm run db:migrate` runs the same
// folder through drizzle-kit; both record applied migrations in drizzle.__drizzle_migrations.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Applies pending migrations as the migration role. Already-applied migrations are skipped. */
export async function runMigrations(migrationUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: migrationUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await migrate(drizzle(client), {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsTable: "__drizzle_migrations",
      migrationsSchema: "drizzle",
    });
  } finally {
    await client.end();
  }
}
