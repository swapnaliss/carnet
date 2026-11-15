// `npm run demo:reset -- [--yes]` (M4-05): restores the seeded demo state, idempotently.
//
// What it restores (runs as the app role, DATABASE_URL):
//   - the demo business, its placeholder and the six dataset payees (never deletes a live run's rows:
//     owner decision 2026-11-11, docs/evidence/m2-run.md)
//   - the demo users: the judge always (SEED_JUDGE_PASSWORD is required, the script refuses without it);
//     owner and approver when their SEED_*_PASSWORD is set (otherwise left as they are). No secret printed.
//   - the kill switches and spend caps (system_flags) to their defaults
//   - every recording under fixtures/replay/*/manifest.json: its timeline and screen refs in the
//     replay_recordings index, and, for a recording with a materializer, its own replay business.
//     A replay business is keyed by the recording's fingerprint: rows the app role cannot delete
//     (drafts, facts, audit) are never deleted, so an unchanged recording is kept as it is and a changed
//     one is loaded into a NEW business (the old one is left unreferenced).
//   - the policy: none is seeded (policies are immutable versions the owner creates); untouched.
// What it deletes (printed first): the judge's sessions (judges sign in again; their per-session
// counters start fresh) and the replay recording index rows (rebuilt).
// It refuses (exit 3, nothing changed) a database without the demo marker (migration 0019), and appends
// one `demo.reset` audit entry (it never truncates audit_log; the chain stays valid, checked at the end).
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  appendAudit,
  createDbClient,
  type Db,
  DEMO_BUSINESS_ID,
  DEMO_USERS,
  ensureDemoBusiness,
  ensureDemoDataset,
  isDemoDatabase,
  listReplayRecordings,
  replaceReplayRecordings,
  repoCtx,
  SeedConfigError,
  schema,
  seedDemoUsers,
  verifyAuditChain,
} from "@carnet/db";
import type { BusinessId } from "@carnet/domain";
import { and, count, eq, sql } from "drizzle-orm";
import { type LoadedRecording, loadRecordings } from "./replay/load";
import { materializeM2 } from "./replay/materialize-m2";

/** Bumped when a materializer changes what it writes, so the next reset loads a new generation. */
// /2: replay transfer ids carry the `replay-` prefix (collided with the live payments on the hosted DB).
const MATERIALIZER_VERSION = "m2-pipeline/2";
const MATERIALIZERS: Record<string, typeof materializeM2> = { "m2-pipeline": materializeM2 };

/** Default system_flags (migration 0001 / M4-02): switches on, USD 10.00 a day, USD 0.50 a run. */
const DEFAULT_FLAGS = {
  agentsEnabled: true,
  executionEnabled: true,
  dailySpendCapMinor: 1000n,
  perRunCapMinor: 50n,
  capCurrency: "USD",
} as const;

const JUDGE = DEMO_USERS.find((u) => u.role === "viewer");
const OWNER = DEMO_USERS.find((u) => u.role === "owner");

function out(line: string): void {
  process.stdout.write(`demo:reset: ${line}\n`);
}

/** A stable UUID from a recording's fingerprint (its replay business id). */
export function replayBusinessId(fingerprint: string, version = MATERIALIZER_VERSION): BusinessId {
  const h = createHash("sha256").update(`${version}:${fingerprint}`).digest("hex");
  const v = `5${h.slice(13, 16)}`;
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}` as BusinessId;
}

async function replayBusinessLoaded(db: Db, businessId: BusinessId): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.payments)
    .where(eq(schema.payments.businessId, businessId));
  return Number(row?.n ?? 0) > 0;
}

async function confirm(yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    out("not a terminal: pass --yes to proceed non-interactively. Nothing changed.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("demo:reset: proceed? type yes: ");
  rl.close();
  return answer.trim() === "yes";
}

interface Plan {
  readonly recording: LoadedRecording;
  readonly businessId: BusinessId | null;
  readonly loaded: boolean;
}

async function main(argv: readonly string[]): Promise<number> {
  const yes = argv.includes("--yes");
  const url = process.env.DATABASE_URL;
  if (!url) {
    out("DATABASE_URL is not set. Nothing changed.");
    return 2;
  }
  if ((process.env.SEED_JUDGE_PASSWORD ?? "").length < 8) {
    out("set SEED_JUDGE_PASSWORD (at least 8 characters); there is no default. Nothing changed.");
    return 1;
  }
  const client = createDbClient(url, { max: 2, connectionTimeoutMillis: 5_000 });
  const db = client.db;
  try {
    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      out(
        `cannot reach the database (${error instanceof Error ? error.message : "error"}). Nothing changed.`,
      );
      return 2;
    }
    if (!(await isDemoDatabase(db))) {
      out(
        "refusing: this database is not marked as the demo database (demo_database, migration 0019). Nothing changed.",
      );
      return 3;
    }

    const recordings = loadRecordings();
    const plans: Plan[] = [];
    for (const r of recordings) {
      const businessId = r.manifest.materialize ? replayBusinessId(r.fingerprint) : null;
      plans.push({
        recording: r,
        businessId,
        loaded: businessId ? await replayBusinessLoaded(db, businessId) : false,
      });
    }
    const [sessions] = JUDGE
      ? await db
          .select({ n: count() })
          .from(schema.authSessions)
          .where(eq(schema.authSessions.userId, JUDGE.id))
      : [{ n: 0 }];
    const index = await listReplayRecordings(db);

    out("will delete:");
    out(`  ${Number(sessions?.n ?? 0)} judge session(s) (the judge signs in again)`);
    out(`  ${index.length} replay recording index row(s) (rebuilt below)`);
    out("will restore: demo business and dataset payees, demo users, kill switches and spend caps");
    for (const p of plans) {
      const what = !p.businessId
        ? "timeline only (no materializer in its manifest)"
        : p.loaded
          ? `kept: already loaded in replay business ${p.businessId}`
          : `load into replay business ${p.businessId}`;
      out(`  recording ${p.recording.id}: ${p.recording.timeline.length} timeline events; ${what}`);
    }
    if (!(await confirm(yes))) return 1;

    await ensureDemoBusiness(db);
    await ensureDemoDataset(db, DEMO_BUSINESS_ID);
    const seeded = await seedDemoUsers(db, {
      businessId: DEMO_BUSINESS_ID,
      optionalKeys: ["SEED_OWNER_PASSWORD", "SEED_APPROVER_PASSWORD"],
    });
    for (const u of seeded.users) out(`user ${u.role} ${u.email} ready`);
    if (JUDGE) await db.delete(schema.authSessions).where(eq(schema.authSessions.userId, JUDGE.id));

    const [flags] = await db.select().from(schema.systemFlags).where(eq(schema.systemFlags.id, 1));
    const flagsDiffer =
      !flags ||
      flags.agentsEnabled !== DEFAULT_FLAGS.agentsEnabled ||
      flags.executionEnabled !== DEFAULT_FLAGS.executionEnabled ||
      flags.dailySpendCapMinor !== DEFAULT_FLAGS.dailySpendCapMinor ||
      flags.perRunCapMinor !== DEFAULT_FLAGS.perRunCapMinor ||
      flags.capCurrency !== DEFAULT_FLAGS.capCurrency;
    if (flags && flagsDiffer) {
      await db
        .update(schema.systemFlags)
        .set({ ...DEFAULT_FLAGS, updatedAt: new Date() })
        .where(eq(schema.systemFlags.id, 1));
    }

    // The owner the recordings' owner actions are attributed to (the demo owner, if seeded).
    const [owner] = OWNER
      ? await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(eq(schema.users.id, OWNER.id)))
      : [];
    const actor = owner?.id ?? JUDGE?.id;
    if (!actor) throw new Error("no demo user to attribute the recording to");

    const rows = [];
    let position = 0;
    for (const p of plans) {
      let refs: Record<string, string> = {};
      const materializer = p.recording.manifest.materialize
        ? MATERIALIZERS[p.recording.manifest.materialize]
        : undefined;
      if (p.businessId && materializer) {
        await db
          .insert(schema.businesses)
          .values({
            id: p.businessId,
            name: `Northwind Studio (recording ${p.recording.id})`,
            timezone: "Asia/Singapore",
          })
          .onConflictDoNothing({ target: schema.businesses.id });
        const existing = index.find(
          (i) => i.id === p.recording.id && i.businessId === p.businessId,
        );
        if (p.loaded && existing) {
          refs = existing.refs;
        } else if (p.loaded) {
          throw new Error(
            `replay business ${p.businessId} has rows but no index entry; bump MATERIALIZER_VERSION to load a new generation`,
          );
        } else {
          refs = { ...(await materializer(db, p.businessId, actor)) };
        }
      }
      rows.push({
        id: p.recording.id,
        position: position++,
        manifest: { ...p.recording.manifest, fingerprint: p.recording.fingerprint },
        timeline: p.recording.timeline,
        refs,
        materialized: Boolean(p.businessId && materializer),
      });
    }
    const primary = [...plans].reverse().find((p) => p.businessId);
    await replaceReplayRecordings(db, rows, primary?.businessId ?? DEMO_BUSINESS_ID);
    // replaceReplayRecordings stores one business for the index; per-recording businesses follow.
    for (const p of plans) {
      if (!p.businessId) continue;
      await db
        .update(schema.replayRecordings)
        .set({ businessId: p.businessId })
        .where(eq(schema.replayRecordings.id, p.recording.id));
    }

    await appendAudit(repoCtx(db, DEMO_BUSINESS_ID), {
      actorType: "system",
      actorId: null,
      action: "demo.reset",
      subject: "demo",
      data: {
        recordings: plans.map((p) => ({
          id: p.recording.id,
          fingerprint: p.recording.fingerprint,
          business_id: p.businessId,
        })),
        flags_restored: flagsDiffer,
      },
    });
    const chain = await verifyAuditChain(db);
    out(`audit chain ${chain.ok ? "OK" : "BROKEN"} (${chain.checked} rows checked)`);
    out("done");
    return chain.ok ? 0 : 4;
  } catch (error) {
    if (error instanceof SeedConfigError) out(error.message);
    else out(`failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await client.close();
  }
}

if (process.argv[1]?.endsWith("demo-reset.ts")) {
  process.exitCode = await main(process.argv.slice(2));
}
