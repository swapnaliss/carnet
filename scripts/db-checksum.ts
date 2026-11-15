// `npm run db:checksum` (M4-05): a checksum of the seeded tables, so two runs of `npm run demo:reset`
// can be compared (`diff`). Read-only, app role (DATABASE_URL). Rows are those of the demo business and
// of every replay business in the recording index; columns that change on every write by design
// (`*_at`, `at`, password and token hashes) are left out. Prints one line per table and a total.
import { createHash } from "node:crypto";
import { createDbClientFromEnv, DEMO_BUSINESS_ID } from "@carnet/db";

/** Tables scoped by business_id. */
const TENANT_TABLES = [
  "users",
  "counterparties",
  "documents",
  "document_facts",
  "payments",
  "evidence_links",
  "rfis",
  "rfi_questions",
  "drafts",
  "draft_answers",
  "obligations",
  "policies",
] as const;
const VOLATILE = /(^at$|_at$|password|token|^hash$|^prev_hash$)/;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((k) => !VOLATILE.test(k))
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function digest(rows: readonly unknown[]): string {
  const lines = rows.map((r) => JSON.stringify(canonical(r))).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

async function main(): Promise<void> {
  const client = createDbClientFromEnv(process.env, { max: 1 });
  try {
    const q = <T>(text: string, params: unknown[] = []) =>
      client.pool.query<T & Record<string, unknown>>(text, params);
    const index = await q<{ r: unknown; business_id: string }>(
      "SELECT to_jsonb(t) AS r, t.business_id FROM replay_recordings t",
    );
    const businesses = [...new Set([DEMO_BUSINESS_ID, ...index.rows.map((x) => x.business_id)])];
    const lines: string[] = [];
    const add = (name: string, rows: readonly unknown[]) =>
      lines.push(`${name.padEnd(18)} ${String(rows.length).padStart(5)} ${digest(rows)}`);

    add(
      "replay_recordings",
      index.rows.map((x) => x.r),
    );
    add(
      "businesses",
      (
        await q<{ r: unknown }>("SELECT to_jsonb(t) AS r FROM businesses t WHERE id = ANY($1)", [
          businesses,
        ])
      ).rows.map((x) => x.r),
    );
    add(
      "system_flags",
      (await q<{ r: unknown }>("SELECT to_jsonb(t) AS r FROM system_flags t")).rows.map((x) => x.r),
    );
    for (const table of TENANT_TABLES) {
      const res = await q<{ r: unknown }>(
        `SELECT to_jsonb(t) AS r FROM ${table} t WHERE business_id = ANY($1)`,
        [businesses],
      );
      add(
        table,
        res.rows.map((x) => x.r),
      );
    }
    const total = createHash("sha256").update(lines.join("\n")).digest("hex");
    process.stdout.write(`${lines.join("\n")}\ntotal ${total}\n`);
  } finally {
    await client.close();
  }
}

await main();
