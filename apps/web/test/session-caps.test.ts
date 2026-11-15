// M4-05 AC 5: per-session caps. A file above UPLOAD_MAX_BYTES is refused 413, an 11th file in a session
// 429, and a model call over SESSION_MODEL_CAP_USD is refused (429 at the route, nothing queued; and
// `cap_exceeded` / cap "session" in the harness before any network call). Every counter is in the
// database: a fresh route kit and a fresh connection pool (a "server restart") see the same counts.
// The database part needs the local Postgres roles (DATABASE_URL and DATABASE_MIGRATION_URL); without
// them only the pure part runs and the rest is skipped loudly.
import { checkCaps, createHarness } from "@carnet/agent";
import { createDbClient, schema, sessionModelSpendNanoUsd } from "@carnet/db";
import { ApiErrorSchema } from "@carnet/domain";
import { count } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { promptVersion } from "../../../packages/agent/src/prompt-version";
import { memoryStore, USD } from "../../../packages/agent/test/memory-store";
import {
  DEFAULT_SESSION_MODEL_CAP_USD,
  SESSION_MODEL_CAP,
  SESSION_MODEL_CAP_MESSAGE,
  sessionAttribution,
  sessionModelCapNanoUsd,
} from "../src/server/session-caps";
import { ORIGIN, sessionCookie, setupAuthTestEnv } from "./auth/setup";
import { DEFAULT_TEST_LIMITS, dataset, documentRoutes, uploadRequest } from "./documents/support";

describe("the session model cap (pure)", () => {
  it("defaults to USD 1.00 and reads SESSION_MODEL_CAP_USD", () => {
    expect(DEFAULT_SESSION_MODEL_CAP_USD).toBe(1);
    expect(sessionModelCapNanoUsd({})).toBe(USD);
    expect(sessionModelCapNanoUsd({ SESSION_MODEL_CAP_USD: "0.25" })).toBe(USD / 4);
    expect(sessionModelCapNanoUsd({ SESSION_MODEL_CAP_USD: "nonsense" })).toBe(USD);
  });

  it("is checked after the per-run and daily caps", () => {
    const base = {
      perRunCapNanoUsd: USD,
      dailyCapNanoUsd: 10 * USD,
      runSpentNanoUsd: 0,
      daySpentNanoUsd: 0,
      worstCaseNanoUsd: USD / 10,
    };
    expect(checkCaps(base)).toEqual({ ok: true });
    expect(checkCaps({ ...base, session: { capNanoUsd: USD, spentNanoUsd: USD } })).toMatchObject({
      ok: false,
      cap: "session",
      remainingNanoUsd: 0,
    });
  });

  it("a job payload carries the session; webhook work has none", () => {
    expect(sessionAttribution({ sessionId: "s1" }, {})).toEqual({
      sessionId: "s1",
      capNanoUsd: USD,
    });
    expect(sessionAttribution({ businessId: "b" }, {})).toBeNull();
  });

  it("the harness refuses a call over the session cap before the network (a spend_cap step)", async () => {
    const store = memoryStore({
      agentsEnabled: true,
      perRunCapNanoUsd: USD,
      dailyCapNanoUsd: 10 * USD,
      session: { capNanoUsd: USD / 100, spentNanoUsd: USD / 100 },
    });
    let sent = 0;
    const harness = createHarness({
      store,
      transport: async () => {
        sent++;
        return new Response("{}", { status: 500 });
      },
    });
    const schemaOut = z.strictObject({ ok: z.boolean() });
    const system = "Answer ok.";
    const run = await harness.startRun({ kind: "test", ref: "session-cap" });
    const out = await harness.callStructured({
      run,
      step: "s",
      promptVersion: promptVersion(system, schemaOut),
      model: "claude-haiku-5-5",
      system,
      blocks: [{ type: "text", text: "hello" }],
      schema: schemaOut,
      maxTokens: 64,
    });
    expect(out).toMatchObject({ outcome: "cap_exceeded", cap: "session" });
    expect(sent).toBe(0);
    expect(store.steps.map((s) => s.outcome)).toEqual(["spend_cap"]);
  });
});

const hasDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_MIGRATION_URL);
if (!hasDb)
  console.warn("session-caps: DATABASE_URL/DATABASE_MIGRATION_URL not set; DB part skipped.");
const env = hasDb ? setupAuthTestEnv() : null;

describe.skipIf(!hasDb)("upload and model caps at the route, durable across a restart", () => {
  let cookie = "";
  let sessionId = "";

  beforeAll(async () => {
    if (!env) return;
    cookie = await sessionCookie(env(), "owner@carnet.example", env().passwords.owner);
    const session = await env().rt.auth.api.getSession({ headers: new Headers({ cookie }) });
    sessionId = session?.session.id ?? "";
  });

  const problem = async (res: Response) => ApiErrorSchema.parse(await res.json()).error;
  const pdf = (n: number) => {
    const bytes = dataset("inv-harbor-001.pdf");
    const copy = new Uint8Array(bytes.byteLength + 16);
    copy.set(bytes);
    copy.set(new TextEncoder().encode(`\n%cap-test-${n}\n`), bytes.byteLength);
    return copy as Uint8Array<ArrayBuffer>;
  };

  it("a file above UPLOAD_MAX_BYTES is 413 and nothing is stored", async () => {
    if (!env) return;
    const routes = documentRoutes(env(), { limits: { ...DEFAULT_TEST_LIMITS, maxBytes: 1024 } });
    const before = (await env().db.select({ n: count() }).from(schema.documents))[0]?.n;
    const res = await routes.upload(
      uploadRequest(cookie, { bytes: pdf(0), name: "big.pdf" }, { kind: "invoice" }),
    );
    expect(res.status).toBe(413);
    expect((await env().db.select({ n: count() }).from(schema.documents))[0]?.n).toBe(before);
  });

  it("the 11th upload attempt of a session is 429, also after a restart", async () => {
    if (!env) return;
    const limits = { ...DEFAULT_TEST_LIMITS, sessionMaxFiles: 10 };
    // The 413 above already counted one attempt; nine more fill the session's ten.
    for (let i = 1; i <= 9; i++) {
      const routes = documentRoutes(env(), { limits });
      const res = await routes.upload(
        uploadRequest(
          cookie,
          { bytes: dataset("inv-harbor-001.pdf"), name: `f${i}.pdf` },
          { kind: "invoice" },
        ),
      );
      expect([200, 201]).toContain(res.status);
    }
    const restarted = documentRoutes(env(), { limits }); // fresh kit: no in-memory state
    const res = await restarted.upload(
      uploadRequest(
        cookie,
        { bytes: dataset("inv-harbor-001.pdf"), name: "f11.pdf" },
        { kind: "invoice" },
      ),
    );
    expect(res.status).toBe(429);
    expect((await problem(res)).code).toBe("RATE_LIMITED");
  });

  it("a session over SESSION_MODEL_CAP_USD gets 429 with the documented message, nothing queued", async () => {
    if (!env) return;
    const { db, businessId } = env();
    await db.insert(schema.agentRuns).values({
      businessId,
      kind: "extraction",
      ref: "session-cap-test",
      status: "DONE",
      costNanoUsd: 2 * USD, // above the default USD 1.00
      sessionId,
    });
    // A "restart": a new pool reads the same spend.
    const url = (db as unknown as { $client: { options: { connectionString: string } } }).$client
      .options.connectionString;
    const fresh = createDbClient(url, { max: 1 });
    try {
      expect(await sessionModelSpendNanoUsd(fresh.db, sessionId)).toBe(2 * USD);
    } finally {
      await fresh.close();
    }
    const jobsBefore = (await db.select({ n: count() }).from(schema.outboxJobs))[0]?.n;
    const routes = documentRoutes(env(), {
      limits: { ...DEFAULT_TEST_LIMITS, sessionMaxFiles: 1000 },
    });
    const res = await routes.upload(
      new Request(`${ORIGIN}/api/v1/documents`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "multipart/form-data; boundary=x" },
        body: "--x--",
      }),
    );
    expect(res.status).toBe(429);
    const err = await problem(res);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.message).toBe(SESSION_MODEL_CAP_MESSAGE);
    expect(err.details).toEqual({ cap: SESSION_MODEL_CAP });
    expect((await db.select({ n: count() }).from(schema.outboxJobs))[0]?.n).toBe(jobsBefore);
  });
});
