// Read-side SQL over the audit log, kept here so that "audit_log" appears in one module (M4-01).
import { type SQL, sql } from "drizzle-orm";

/** A scalar subquery counting `action` entries in [start, now]; `scope` is an extra AND clause. */
export function auditActionCountSql(action: string, start: Date, now: Date, scope: SQL): SQL {
  return sql`(SELECT count(*) FROM audit_log WHERE action = ${action}
            AND at >= ${start} AND at <= ${now} ${scope})`;
}
