// Test support (M4-01): what a privileged attacker does to the audit log, for the /ops e2e spec.
// Lives under test/ so the "audit_log is named in one module" source gate stays about product code.
import pg from "pg";

async function asOwner<T>(migrationUrl: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: migrationUrl });
  await c.connect();
  try {
    await c.query("ALTER TABLE audit_log DISABLE TRIGGER USER");
    return await fn(c);
  } finally {
    await c.query("ALTER TABLE audit_log ENABLE TRIGGER USER");
    await c.end();
  }
}

/** Changes the newest row with `action` to `forged`, leaving its hash alone; returns that row's id. */
export function forgeLatestAction(
  migrationUrl: string,
  action: string,
  forged: string,
): Promise<string> {
  return asOwner(migrationUrl, async (c) => {
    const id = (
      await c.query<{ id: string }>(
        "select id from audit_log where action = $1 order by id desc limit 1",
        [action],
      )
    ).rows[0]?.id;
    if (!id) throw new Error(`no audit row with action ${action}`);
    await c.query("update audit_log set action = $1 where id = $2", [forged, id]);
    return id;
  });
}

export function restoreAction(migrationUrl: string, id: string, action: string): Promise<void> {
  return asOwner(migrationUrl, async (c) => {
    await c.query("update audit_log set action = $1 where id = $2", [action, id]);
  });
}
