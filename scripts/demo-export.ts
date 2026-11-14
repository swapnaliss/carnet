// Read-only export of what one live core-demo run left in the deployed database (M2-09). It exists
// because the model's responses (agent_steps.output), token counts, costs, audit entries and webhook
// bodies are not exposed by any API, and the run record and the replay fixtures are made from them.
//
//   EXPORT_SINCE=2026-11-11T12:00:00Z node runtime/demo-export.mjs     (Render one-off job; scripts/demo-export.sh)
//   EXPORT_SINCE=... npx tsx scripts/demo-export.ts                    (a checkout, DATABASE_URL set)
//
// Runs as the app role and only SELECTs. One JSON object per log line: {"table","row"}, then a final
// {"summary"}. It never exports users, sessions, credentials, idempotency keys, rate limits or document
// bytes, and it drops every key whose name looks like a secret (signature, secret, token, password,
// authorization, cookie) at any depth. Synthetic data only; the output is still scrubbed locally by
// scripts/spikes/airwallex scrub tooling before it is committed (check-no-secrets.sh must pass).
import { createDbClient, DEMO_BUSINESS_ID } from "@carnet/db";

/** Tables to export (those that exist and have `business_id`), and the time column to filter on. */
const TABLES = [
  "agent_runs",
  "agent_steps",
  "audit_log",
  "execution_attempts",
  "payments",
  "rfis",
  "rfi_questions",
  "webhook_events",
  "approvals",
  "evidence_links",
  "document_facts",
  // M3-07: the plan, its actions and their execution, the auto-approval records, obligations and the
  // criticality proposals. Payee links are exported without their token hash (the key filter drops it).
  "plans",
  "plan_actions",
  "plan_action_states",
  "auto_approvals",
  "obligations",
  "criticality_proposals",
  "fx_quote_uses",
  "payee_links",
] as const;
const TIME_COLUMNS = ["created_at", "received_at", "at", "updated_at"] as const;
const SECRET_KEY = /signature|secret|token|password|authorization|cookie/i;

function log(extra: Record<string, unknown>): void {
  console.log(JSON.stringify({ process: "demo-export", ...extra }));
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEY.test(k))
        .map(([k, v]) => [k, strip(v)]),
    );
  }
  return value;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const since = process.env.EXPORT_SINCE;
  if (!since || Number.isNaN(Date.parse(since))) {
    throw new Error("EXPORT_SINCE must be an ISO timestamp");
  }
  const client = createDbClient(url, { max: 2 });
  const counts: Record<string, number> = {};
  try {
    const { rows: cols } = await client.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [[...TABLES, "drafts", "draft_answers"]],
    );
    const byTable = new Map<string, Set<string>>();
    for (const c of cols) {
      byTable.set(c.table_name, (byTable.get(c.table_name) ?? new Set()).add(c.column_name));
    }
    for (const table of [...TABLES, "drafts", "draft_answers"]) {
      const names = byTable.get(table);
      if (!names) {
        log({ skipped: table, reason: "no such table" });
        continue;
      }
      const time = TIME_COLUMNS.find((c) => names.has(c));
      const scope = names.has("business_id") ? "t.business_id = $1" : "true";
      const params: unknown[] = names.has("business_id") ? [DEMO_BUSINESS_ID] : [];
      const filter = time ? ` AND t."${time}" >= $${params.length + 1}` : "";
      if (time) params.push(since);
      // table and column names come from the fixed lists above, never from input.
      const { rows } = await client.pool.query<{ row: unknown }>(
        `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE ${scope}${filter} ORDER BY 1`,
        params,
      );
      counts[table] = rows.length;
      for (const r of rows) log({ table, row: strip(r.row) });
    }
    log({ summary: counts, since });
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      process: "demo-export",
      message: "demo export failed",
      error: (error instanceof Error ? error.message : String(error)).split("\nparams:")[0],
    }),
  );
  process.exit(1);
});
