// Connection setup. The app connects as the app role through DATABASE_URL; migrations use
// DATABASE_MIGRATION_URL (drizzle.config.ts, src/migrate.ts). Every connection has timeouts.
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema/index";

export type Schema = typeof schema;
/** A database handle or an open transaction; every repository function accepts either. */
export type Db = PgDatabase<NodePgQueryResultHKT, Schema>;
export type Tx = PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export const DB_ENV_KEYS = ["DATABASE_URL", "DATABASE_MIGRATION_URL"] as const;

export interface DbClientOptions {
  /** Pool size (default 10). */
  max?: number;
  /** Time to get a connection, ms (default 5000). */
  connectionTimeoutMillis?: number;
  /** Server-side statement timeout, ms (default 10000). */
  statementTimeoutMillis?: number;
  /** Called when an idle pooled client errors (the pool replaces it). */
  onIdleError?: (error: Error) => void;
}

export interface DbClient {
  readonly db: Db;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export function createDbClient(connectionString: string, options: DbClientOptions = {}): DbClient {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    statement_timeout: options.statementTimeoutMillis ?? 10_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: "carnet",
  });
  pool.on("error", (error) => options.onIdleError?.(error));
  const db: Db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

/** The app-role client from `DATABASE_URL`. */
export function createDbClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: DbClientOptions = {},
): DbClient {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return createDbClient(url, options);
}

/** Runs `fn` in one transaction (state change and outbox job together, ADR 0005). */
export function withTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(tx));
}
