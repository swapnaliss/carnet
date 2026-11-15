// Adds the dataset's payees to the deployed demo business (M2-09) and, when it has no policy yet, the
// demo auto-FX policy as version 1 (M3-07). Idempotent and add-only; never updates or deletes.
//
//   npx tsx scripts/demo-seed.ts            (a checkout, DATABASE_URL set)
//   node runtime/demo-seed.mjs              (in the image, as a Render one-off job; see scripts/demo-reset.sh)
//
// Runs as the app role (DATABASE_URL). Prints the counterparty count so two runs can be compared.
import { createDbClient, DEMO_BUSINESS_ID, ensureDemoDataset, ensureDemoPolicy } from "@carnet/db";

function log(message: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", process: "demo-seed", message, ...extra }));
}

function pgCause(cause: unknown): Record<string, unknown> | null {
  if (!cause || typeof cause !== "object") return null;
  const e = cause as Record<string, unknown>;
  return {
    message: e.message,
    code: e.code,
    constraint: e.constraint,
    table: e.table,
    detail: e.detail,
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = createDbClient(url, { max: 2 });
  try {
    const result = await ensureDemoDataset(client.db, DEMO_BUSINESS_ID);
    const { rows } = await client.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM counterparties WHERE business_id = $1",
      [DEMO_BUSINESS_ID],
    );
    log("dataset payees ready", { inserted: result.inserted, counterparties: rows[0]?.n });
    const policy = await ensureDemoPolicy(client.db, DEMO_BUSINESS_ID);
    log(policy.created ? "demo policy stored" : "policy already present, left unchanged", {
      version: policy.version,
      hash: policy.hash,
    });
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      process: "demo-seed",
      message: "demo seed failed",
      error: (error instanceof Error ? error.message : String(error)).split("\nparams:")[0],
      // drizzle wraps the driver error: the Postgres code, constraint and detail are on `cause`.
      cause: pgCause((error as { cause?: unknown } | null)?.cause),
    }),
  );
  process.exit(1);
});
