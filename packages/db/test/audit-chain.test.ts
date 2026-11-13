// M4-01 / ADR 0013: the hash chain. appendAudit is the only writer; verifyAuditChain detects what a
// privileged attacker (the migration role, simulated here) does to the log.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendAudit } from "../src/audit/append";
import { computeAuditHash, GENESIS_HASH } from "../src/audit/hash";
import {
  readAuditChainStatus,
  verifyAndStoreAuditChain,
  verifyAuditChain,
} from "../src/audit/verify";
import { createBusiness, repoCtx } from "../src/repos/index";
import { useTestDatabase, withClient } from "./harness";

const db = useTestDatabase({ prefix: "audit_chain" });
let ctx: ReturnType<typeof repoCtx>;

beforeAll(async () => {
  const biz = await createBusiness(db().app.db, { name: "Audit Co" });
  ctx = repoCtx(db().app.db, biz);
});

/** Runs SQL as the migration role (the owner) with the audit triggers off: a privileged attacker. */
async function asOwner(...statements: string[]): Promise<void> {
  await withClient(db().migrationUrl, async (c) => {
    await c.query("ALTER TABLE audit_log DISABLE TRIGGER USER");
    try {
      for (const s of statements) await c.query(s);
    } finally {
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER USER");
    }
  });
}

async function resetChain(): Promise<void> {
  await asOwner(
    "DELETE FROM audit_log",
    "UPDATE audit_chain_head SET last_id = NULL, last_hash = NULL, row_count = 0",
  );
}

async function appendN(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await appendAudit(ctx, {
      actorType: i % 2 ? "agent" : "user",
      actorId: `a-${i}`,
      action: "test.event",
      subject: `thing:${i}`,
      data: { i, nested: { b: 2, a: [1, { z: 1, y: 2 }] } },
    });
  }
}

const ids = async (): Promise<bigint[]> =>
  (
    await withClient(db().migrationUrl, (c) =>
      c.query<{ id: string }>("SELECT id FROM audit_log ORDER BY id"),
    )
  ).rows.map((r) => BigInt(r.id));

describe("hash function", () => {
  it("is stable under key order and uses the documented genesis", () => {
    const base = {
      prevHash: GENESIS_HASH,
      at: new Date("2026-11-13T10:00:00.123Z"),
      actorType: "system",
      actorId: null,
      action: "x",
      subject: "s",
    };
    const a = computeAuditHash({ ...base, data: { a: 1, b: { c: 2, d: 3 } } });
    const b = computeAuditHash({ ...base, data: { b: { d: 3, c: 2 }, a: 1 } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(GENESIS_HASH).toBe("0".repeat(64));
    expect(computeAuditHash({ ...base, data: { a: 2 } })).not.toBe(a);
  });
});

describe("appendAudit and verifyAuditChain", () => {
  beforeEach(resetChain);

  it("an empty log verifies", async () => {
    expect(await verifyAuditChain(db().app.db)).toMatchObject({ ok: true, checked: 0 });
  });

  it("links every row to the previous one, starting at the genesis", async () => {
    await appendN(5);
    const rows = (
      await withClient(db().migrationUrl, (c) =>
        c.query<{ prev_hash: string; hash: string }>(
          "SELECT prev_hash, hash FROM audit_log ORDER BY id",
        ),
      )
    ).rows;
    expect(rows[0]?.prev_hash).toBe(GENESIS_HASH);
    for (let i = 1; i < rows.length; i++) expect(rows[i]?.prev_hash).toBe(rows[i - 1]?.hash);
    const result = await verifyAuditChain(db().app.db);
    expect(result).toMatchObject({ ok: true, checked: 5, headHash: rows[4]?.hash });
  });

  it("200 concurrent appends from several connections give one valid, gap-free chain", async () => {
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        appendAudit(ctx, {
          actorType: "system",
          action: "test.concurrent",
          subject: `n:${i}`,
          data: { i },
        }),
      ),
    );
    expect(results).toHaveLength(200);
    const result = await verifyAuditChain(db().app.db);
    expect(result).toMatchObject({ ok: true, checked: 200 });
    const all = await ids();
    expect(new Set(all).size).toBe(200);
    // the chain is a single line: every prev_hash is used exactly once
    const dup = await withClient(db().migrationUrl, (c) =>
      c.query("SELECT prev_hash FROM audit_log GROUP BY prev_hash HAVING count(*) > 1"),
    );
    expect(dup.rowCount).toBe(0);
  });

  it("a rolled-back append leaves no row and does not advance the head", async () => {
    await appendN(2);
    const before = await verifyAuditChain(db().app.db);
    await expect(
      db().app.db.transaction(async (tx) => {
        await appendAudit(
          { ...ctx, db: tx },
          { actorType: "system", action: "test.rollback", subject: "r" },
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const after = await verifyAuditChain(db().app.db);
    expect(after).toMatchObject({ ok: true, checked: 2, headHash: before.headHash });
    const head = await withClient(db().migrationUrl, (c) =>
      c.query<{ row_count: string }>("SELECT row_count FROM audit_chain_head"),
    );
    expect(head.rows[0]?.row_count).toBe("2");
    // the chain continues cleanly after the rollback
    await appendN(1);
    expect(await verifyAuditChain(db().app.db)).toMatchObject({ ok: true, checked: 3 });
  });

  it("stores the agent's identity as given", async () => {
    const e = await appendAudit(ctx, {
      actorType: "agent",
      actorId: "agent:drafting",
      action: "a",
      subject: "s",
    });
    expect(e).toMatchObject({ actorType: "agent", actorId: "agent:drafting" });
  });
});

describe("tamper detection (privileged attacker)", () => {
  beforeEach(async () => {
    await resetChain();
    await appendN(6);
  });

  it("a modified row is HASH_MISMATCH at that row", async () => {
    const all = await ids();
    await asOwner(`UPDATE audit_log SET action = 'forged' WHERE id = ${all[3]}`);
    expect(await verifyAuditChain(db().app.db)).toMatchObject({
      ok: false,
      reason: "HASH_MISMATCH",
      firstBadId: all[3],
    });
  });

  it("a modified data field is HASH_MISMATCH", async () => {
    const all = await ids();
    await asOwner(`UPDATE audit_log SET data = '{"i": 999}' WHERE id = ${all[1]}`);
    expect(await verifyAuditChain(db().app.db)).toMatchObject({
      ok: false,
      reason: "HASH_MISMATCH",
      firstBadId: all[1],
    });
  });

  it("a deleted middle row is LINK_MISMATCH at the row after it", async () => {
    const all = await ids();
    await asOwner(`DELETE FROM audit_log WHERE id = ${all[2]}`);
    expect(await verifyAuditChain(db().app.db)).toMatchObject({
      ok: false,
      reason: "LINK_MISMATCH",
      firstBadId: all[3],
    });
  });

  it("a deleted first row is GENESIS_MISMATCH", async () => {
    const all = await ids();
    await asOwner(`DELETE FROM audit_log WHERE id = ${all[0]}`);
    expect(await verifyAuditChain(db().app.db)).toMatchObject({
      ok: false,
      reason: "GENESIS_MISMATCH",
      firstBadId: all[1],
    });
  });

  it("a deleted last row is caught by the stored head", async () => {
    const all = await ids();
    await asOwner(`DELETE FROM audit_log WHERE id = ${all[5]}`);
    expect(await verifyAuditChain(db().app.db)).toMatchObject({
      ok: false,
      reason: "HEAD_MISMATCH",
    });
  });

  it("a head whose row count disagrees with the log is GAP", async () => {
    await asOwner("UPDATE audit_chain_head SET row_count = row_count + 3");
    expect(await verifyAuditChain(db().app.db)).toMatchObject({ ok: false, reason: "GAP" });
  });

  it("a reordered pair is reported", async () => {
    const all = await ids();
    const [a, b] = [all[2], all[3]];
    // swap the whole content of the two rows, so each sits where the other was written
    await asOwner(`WITH s AS (SELECT * FROM audit_log WHERE id IN (${a}, ${b}))
      UPDATE audit_log t SET prev_hash = o.prev_hash, hash = o.hash, at = o.at,
        actor_type = o.actor_type, actor_id = o.actor_id, action = o.action,
        subject = o.subject, data = o.data
      FROM s o WHERE t.id IN (${a}, ${b}) AND o.id = CASE WHEN t.id = ${a} THEN ${b} ELSE ${a} END`);
    const r = await verifyAuditChain(db().app.db);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("LINK_MISMATCH");
    expect(r.firstBadId).toBe(a);
  });

  it("an unhashed row inserted after the chain began is flagged", async () => {
    await withClient(db().appUrl, (c) =>
      c.query("INSERT INTO audit_log (actor_type, action, subject) VALUES ('system','forged','x')"),
    );
    expect(await verifyAuditChain(db().app.db)).toMatchObject({
      ok: false,
      reason: "HASH_MISMATCH",
    });
  });

  it("a range verification checks links from the row before `from`", async () => {
    const all = await ids();
    expect(await verifyAuditChain(db().app.db, { from: all[2], to: all[4] })).toMatchObject({
      ok: true,
      checked: 3,
    });
    await asOwner(`UPDATE audit_log SET subject = 'forged' WHERE id = ${all[3]}`);
    expect(await verifyAuditChain(db().app.db, { from: all[2], to: all[4] })).toMatchObject({
      ok: false,
      firstBadId: all[3],
    });
  });

  it("stores the result for /ops", async () => {
    const ok = await verifyAndStoreAuditChain(db().app.db);
    expect(ok.ok).toBe(true);
    expect(await readAuditChainStatus(db().app.db)).toMatchObject({ ok: true, checked: 6 });
    const all = await ids();
    await asOwner(`UPDATE audit_log SET action = 'forged' WHERE id = ${all[4]}`);
    await verifyAndStoreAuditChain(db().app.db);
    expect(await readAuditChainStatus(db().app.db)).toMatchObject({
      ok: false,
      reason: "HASH_MISMATCH",
      firstBadId: all[4],
    });
  });
});

describe("one writer, one hash (source scan)", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", "test", "e2e", "migrations", ".next", "dist", ".claude"].includes(name))
        continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(join(root, "packages"));
  walk(join(root, "apps"));
  const outsideAudit = files.filter((f) => !f.includes("/packages/db/src/audit/"));

  it("no code outside the audit module inserts into audit_log", () => {
    const offenders = outsideAudit.filter((f) => {
      const s = readFileSync(f, "utf8");
      return /insert\(\s*auditLog\s*\)/.test(s) || /INSERT\s+INTO\s+"?audit_log/i.test(s);
    });
    expect(offenders).toEqual([]);
  });

  it("no code outside the audit module computes the audit hash", () => {
    const offenders = outsideAudit.filter((f) => /computeAuditHash/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
