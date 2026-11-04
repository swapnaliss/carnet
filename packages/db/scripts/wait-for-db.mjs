#!/usr/bin/env node
// Waits until DATABASE_MIGRATION_URL accepts a connection (a container that is still initialising
// refuses or resets connections), with jittered backoff and a 60 s deadline. Run before migrations.
import pg from "pg";

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error("wait-for-db: DATABASE_MIGRATION_URL is not set");
  process.exit(1);
}
const deadline = Date.now() + Number(process.env.DB_WAIT_TIMEOUT_MS ?? 60_000);
let delay = 250;
let lastError = "";
for (;;) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    process.exit(0);
  } catch (error) {
    lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await client.end().catch(() => {});
    // 28P01 (bad password) or 3D000 (no database) will not fix themselves: fail now.
    const code = /** @type {{ code?: string }} */ (error).code;
    if (code === "28P01" || code === "3D000" || code === "28000") break;
  }
  if (Date.now() > deadline) break;
  await new Promise((r) => setTimeout(r, delay / 2 + Math.random() * (delay / 2)));
  delay = Math.min(delay * 2, 4_000);
}
console.error(`wait-for-db: database not reachable: ${lastError}`);
process.exit(1);
