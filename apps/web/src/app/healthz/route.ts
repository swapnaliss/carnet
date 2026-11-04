import { createDbClient, type DbClient } from "@carnet/db";
import { appVersion, healthPayload, probeDb } from "../../health";

export const dynamic = "force-dynamic";

// One small pool per process, created on first use; the app role from DATABASE_URL.
let client: DbClient | null = null;
function dbClient(): DbClient | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  client ??= createDbClient(url, {
    max: 2,
    connectionTimeoutMillis: 2_000,
    statementTimeoutMillis: 2_000,
  });
  return client;
}

export async function GET(): Promise<Response> {
  const c = dbClient();
  const db = await probeDb(c ? () => c.pool.query("SELECT 1") : null);
  const { httpStatus, body } = healthPayload(db, appVersion());
  return Response.json(body, { status: httpStatus, headers: { "cache-control": "no-store" } });
}
