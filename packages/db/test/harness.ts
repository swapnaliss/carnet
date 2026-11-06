// Test harness: each Vitest worker gets its own database `carnet_test_<worker>`, created by the
// migration role, migrated, and dropped when the test file finishes. Uses DATABASE_MIGRATION_URL and
// DATABASE_URL only (their database name is replaced). Refuses any non-local host so a test can
// never touch a hosted database.
import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { createDbClient, type DbClient } from "../src/client";
import { runMigrations } from "../src/migrate";

/**
 * The tables M1-02 creates (docs/architecture.md §5), plus the better-auth tables (M1-04) and the
 * model run tables (M2-00)
 * and documents (M2-01).
 */
export const M1_TABLES = [
  "agent_runs",
  "agent_steps",
  "audit_log",
  "auth_accounts",
  "auth_sessions",
  "auth_verifications",
  "businesses",
  "counterparties",
  "documents",
  "execution_attempts",
  "idempotency_keys",
  "outbox_jobs",
  "payments",
  "plan_actions",
  "plans",
  "rate_limits",
  "system_flags",
  "users",
  "webhook_events",
  "worker_heartbeats",
] as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

export interface TestDatabase {
  /** `carnet_test_<worker>` */
  readonly name: string;
  readonly migrationUrl: string;
  readonly appUrl: string;
  /** App-role client (DATABASE_URL credentials) on the test database. */
  readonly app: DbClient;
}

export function workerId(): string {
  return process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "0";
}

function requireUrl(key: "DATABASE_URL" | "DATABASE_MIGRATION_URL"): URL {
  const raw = process.env[key];
  if (!raw) throw new Error(`${key} is not set (see .env.example and packages/db/sql/roles.sql)`);
  const url = new URL(raw);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`${key} must point at a local Postgres for tests (got host ${url.hostname})`);
  }
  return url;
}

export function withDatabase(url: URL, database: string): string {
  const copy = new URL(url.toString());
  copy.pathname = `/${database}`;
  return copy.toString();
}

/** Connects as `connectionString`, runs `fn`, disconnects. */
export async function withClient<T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function dropDatabase(maintenanceUrl: string, name: string): Promise<void> {
  await withClient(maintenanceUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${name}"`));
}

/**
 * Registers beforeAll/afterAll hooks and returns an accessor for the worker's database.
 * Call once at the top of a test file.
 */
export function useTestDatabase(options: { prefix?: string } = {}): () => TestDatabase {
  let current: TestDatabase | undefined;
  let maintenanceUrl = "";

  beforeAll(async () => {
    const migration = requireUrl("DATABASE_MIGRATION_URL");
    const app = requireUrl("DATABASE_URL");
    // Another workspace's suite passes a prefix (apps/web: "web") so its databases never collide
    // with this package's when both projects run at once.
    const name = `carnet_test_${options.prefix ? `${options.prefix}_` : ""}${workerId()}`;
    if (!/^carnet_test_[0-9a-z_]+$/.test(name)) throw new Error(`bad test database name ${name}`);
    maintenanceUrl = migration.toString();
    await dropDatabase(maintenanceUrl, name); // a crashed earlier run may have left it behind
    await withClient(maintenanceUrl, (c) => c.query(`CREATE DATABASE "${name}"`));
    const migrationUrl = withDatabase(migration, name);
    await runMigrations(migrationUrl);
    const appUrl = withDatabase(app, name);
    current = { name, migrationUrl, appUrl, app: createDbClient(appUrl, { max: 4 }) };
  });

  afterAll(async () => {
    if (!current) return;
    await current.app.close();
    await dropDatabase(maintenanceUrl, current.name);
    current = undefined;
  });

  return () => {
    if (!current) throw new Error("test database is not ready (use it inside a test or hook)");
    return current;
  };
}

/** Runs `sql` as the app role and returns the SQLSTATE it failed with, or null on success. */
export async function sqlStateOf(appUrl: string, sql: string): Promise<string | null> {
  return withClient(appUrl, async (c) => {
    try {
      await c.query(sql);
      return null;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return typeof code === "string" ? code : "UNKNOWN";
    }
  });
}
