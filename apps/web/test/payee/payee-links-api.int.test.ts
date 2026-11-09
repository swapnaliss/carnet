// The owner API for payee status links (M3-06) with real sessions and a real database: roles,
// tenancy, idempotency, expiry, revoke, audit, and that the raw token is returned once and kept nowhere.
import http from "node:http";
import https from "node:https";
import { createBusiness, createPayment, listAudit, repoCtx, schema } from "@carnet/db";
import { money, type PaymentId } from "@carnet/domain";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createRouteKit, type RouteHandler } from "../../src/lib/define-route";
import { payeeLinkSpecs } from "../../src/server/payee-links-routes";
import { hashPayeeToken } from "../../src/server/payee-status";
import { createPayeeStatusHandler } from "../../src/server/payee-status-handler";
import { addUser, ORIGIN, sessionCookie, setupAuthTestEnv } from "../auth/setup";

const env = setupAuthTestEnv();
const cookies = { owner: "", approver: "", judge: "", otherOwner: "" };
let own: PaymentId;
let foreign: PaymentId;
let list: RouteHandler;
let create: RouteHandler;
let revoke: RouteHandler;
let seq = 0;

beforeAll(async () => {
  const { db, passwords, businessId } = env();
  const kit = createRouteKit({
    authz: env().authz,
    db: () => db,
    logger: () => env().rt.logger,
    now: () => new Date(),
  });
  list = kit.defineRoute(payeeLinkSpecs.list);
  create = kit.defineRoute(payeeLinkSpecs.create);
  revoke = kit.defineRoute(payeeLinkSpecs.revoke);
  const mk = (b: typeof businessId) =>
    createPayment(repoCtx(db, b), {
      amount: money(1000n, "USD"),
      sourceCurrency: "USD",
      method: "SWIFT",
      reference: "payee-links",
    });
  own = (await mk(businessId)).id;
  const other = await createBusiness(db, { name: "Business B (synthetic)" });
  foreign = (await mk(other)).id;
  await addUser(db, other, {
    email: "owner@b.example",
    role: "owner",
    password: "b-owner-password",
  });
  cookies.owner = await sessionCookie(env(), "owner@carnet.example", passwords.owner);
  cookies.approver = await sessionCookie(env(), "approver@carnet.example", passwords.approver);
  cookies.judge = await sessionCookie(env(), "judge@carnet.example", passwords.judge);
  cookies.otherOwner = await sessionCookie(env(), "owner@b.example", "b-owner-password");
});

const base = (id: string) => `${ORIGIN}/api/v1/payments/${id}/payee-links`;

function post(
  id: string,
  cookie: string | null,
  body: unknown = {},
  key: string | null = `k-${++seq}-${Date.now()}`,
) {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (key) headers["idempotency-key"] = key;
  return create(new Request(base(id), { method: "POST", headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
}
const get = (id: string, cookie: string | null) =>
  list(new Request(base(id), { headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } }), {
    params: Promise.resolve({ id }),
  });
const del = (id: string, linkId: string, cookie: string | null) =>
  revoke(
    new Request(`${base(id)}/${linkId}`, {
      method: "DELETE",
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    }),
    { params: Promise.resolve({ id, linkId }) },
  );

interface Created {
  link: { id: string; state: string; expires_at: string; disclosure_level: string };
  path: string | null;
  replayed: boolean;
}

describe("create", () => {
  it("owner and approver get 201, the address once, and a link that works", async () => {
    for (const cookie of [cookies.owner, cookies.approver]) {
      const res = await post(own, cookie, { disclosure_level: "GENERIC" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Created;
      expect(body.path).toMatch(/^\/status\/[A-Za-z0-9_-]{43}$/);
      expect(body.replayed).toBe(false);
      expect(body.link.state).toBe("active");

      const token = body.path?.split("/").pop() ?? "";
      const [row] = await env()
        .db.select()
        .from(schema.payeeLinks)
        .where(eq(schema.payeeLinks.id, body.link.id));
      expect(row?.tokenHash).toBe(hashPayeeToken(token));

      const page = createPayeeStatusHandler({
        db: () => env().db,
        logger: () => env().rt.logger,
        now: () => new Date(),
        openRfi: async () => false,
        env: { PAYEE_STATUS_RATE_LIMIT_PER_MIN: "1000" },
      });
      const view = await page(
        new Request(`${ORIGIN}/status/${token}`, {
          headers: { "x-forwarded-for": "203.0.113.77" },
        }),
        { params: Promise.resolve({ token }) },
      );
      expect(view.status).toBe(200);
    }
  });

  it("the default expiry is PAYEE_LINK_TTL_HOURS, and an explicit one is honoured up to 30 days", async () => {
    process.env.PAYEE_LINK_TTL_HOURS = "24";
    try {
      const before = Date.now();
      const a = (await (await post(own, cookies.owner)).json()) as Created;
      const hours = (Date.parse(a.link.expires_at) - before) / 3_600_000;
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThan(24.1);
    } finally {
      delete process.env.PAYEE_LINK_TTL_HOURS;
    }
    const max = await post(own, cookies.owner, { expires_in_hours: 720 });
    expect(max.status).toBe(201);
    const over = await post(own, cookies.owner, { expires_in_hours: 721 });
    expect(over.status).toBe(400);
  });

  it("stores the opt-in level only when the owner chooses it", async () => {
    const def = (await (await post(own, cookies.owner, {})).json()) as Created;
    expect(def.link.disclosure_level).toBe("GENERIC");
    const opt = (await (
      await post(own, cookies.owner, { disclosure_level: "DELAYED_FOR_VERIFICATION" })
    ).json()) as Created;
    expect(opt.link.disclosure_level).toBe("DELAYED_FOR_VERIFICATION");
  });

  it("a viewer gets 403, no session 401, another business's payment 404 and nothing is written", async () => {
    const before = (await env().db.select().from(schema.payeeLinks)).length;
    expect((await post(own, cookies.judge)).status).toBe(403);
    expect((await post(own, null)).status).toBe(401);
    const cross = await post(foreign, cookies.owner);
    expect(cross.status).toBe(404);
    expect((await post(own, cookies.otherOwner)).status).toBe(404);
    expect((await env().db.select().from(schema.payeeLinks)).length).toBe(before);
  });

  it("requires an Idempotency-Key", async () => {
    const res = await post(own, cookies.owner, {}, null);
    expect(res.status).toBe(400);
    expect((await post(own, cookies.owner, {}, "short")).status).toBe(400);
  });

  it("a retry with the same key and body returns the same link without the address; another body is 422", async () => {
    const key = `idem-${Date.now()}`;
    const first = (await (
      await post(own, cookies.owner, { expires_in_hours: 5 }, key)
    ).json()) as Created;
    const again = await post(own, cookies.owner, { expires_in_hours: 5 }, key);
    expect(again.status).toBe(201);
    const replay = (await again.json()) as Created;
    expect(replay.link.id).toBe(first.link.id);
    expect(replay.path).toBeNull();
    expect(replay.replayed).toBe(true);
    const clash = await post(own, cookies.owner, { expires_in_hours: 6 }, key);
    expect(clash.status).toBe(422);
    const rows = await env()
      .db.select()
      .from(schema.payeeLinks)
      .where(eq(schema.payeeLinks.id, first.link.id));
    expect(rows).toHaveLength(1);
  });

  it("the audit log records creation without the token", async () => {
    const res = (await (await post(own, cookies.owner)).json()) as Created;
    const entries = await listAudit(repoCtx(env().db, env().businessId), 50);
    const entry = entries.find(
      (e) => e.action === "payee_link.created" && JSON.stringify(e.data).includes(res.link.id),
    );
    expect(entry).toBeDefined();
    const token = res.path?.split("/").pop() ?? "";
    expect(
      JSON.stringify(entries, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ).not.toContain(token);
  });

  it("makes no outbound HTTP request (no email, no webhook): create, list and revoke", async () => {
    const spies = [
      vi.spyOn(globalThis, "fetch"),
      vi.spyOn(http, "request"),
      vi.spyOn(https, "request"),
    ];
    const res = (await (await post(own, cookies.owner)).json()) as Created;
    await get(own, cookies.owner);
    await del(own, res.link.id, cookies.owner);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe("list", () => {
  it("returns this business's links without any token or hash; a viewer may read; another business sees 404", async () => {
    const created = (await (await post(own, cookies.owner)).json()) as Created;
    const res = await get(own, cookies.judge);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(created.link.id);
    expect(text).not.toContain(created.path?.split("/").pop() ?? "x");
    expect(text).not.toMatch(/token|hash/i);
    expect((await get(own, cookies.otherOwner)).status).toBe(404);
    expect((await get(foreign, cookies.owner)).status).toBe(404);
    expect((await get(own, null)).status).toBe(401);
  });
});

describe("revoke", () => {
  it("owner revokes; the link then answers 404; revoking twice is harmless", async () => {
    const created = (await (await post(own, cookies.owner)).json()) as Created;
    const token = created.path?.split("/").pop() ?? "";
    const res = await del(own, created.link.id, cookies.approver);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { link: { state: string } }).link.state).toBe("revoked");
    expect((await del(own, created.link.id, cookies.owner)).status).toBe(200);
    const page = createPayeeStatusHandler({
      db: () => env().db,
      logger: () => env().rt.logger,
      now: () => new Date(),
      openRfi: async () => false,
      env: { PAYEE_STATUS_RATE_LIMIT_PER_MIN: "1000" },
    });
    const view = await page(
      new Request(`${ORIGIN}/status/${token}`, { headers: { "x-forwarded-for": "203.0.113.78" } }),
      { params: Promise.resolve({ token }) },
    );
    expect(view.status).toBe(404);
  });

  it("a viewer gets 403, another business 404, an unknown id 404", async () => {
    const created = (await (await post(own, cookies.owner)).json()) as Created;
    expect((await del(own, created.link.id, cookies.judge)).status).toBe(403);
    expect((await del(own, created.link.id, cookies.otherOwner)).status).toBe(404);
    expect((await del(own, created.link.id, null)).status).toBe(401);
    expect((await del(own, "00000000-0000-4000-8000-000000000000", cookies.owner)).status).toBe(
      404,
    );
    // Still active after the refused attempts.
    const [row] = await env()
      .db.select()
      .from(schema.payeeLinks)
      .where(eq(schema.payeeLinks.id, created.link.id));
    expect(row?.revokedAt).toBeNull();
  });
});
