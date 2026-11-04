// The web process's app-role database client (DATABASE_URL), created on first use so `next build`
// never needs a database. One pool per process.
import { createDbClientFromEnv, type DbClient } from "@carnet/db";

let client: DbClient | null = null;

export function appDb(): DbClient {
  client ??= createDbClientFromEnv(process.env, { max: 10 });
  return client;
}

/** Closes the pool (tests and shutdown). The next `appDb()` opens a new one. */
export async function closeAppDb(): Promise<void> {
  const c = client;
  client = null;
  if (c) await c.close();
}
