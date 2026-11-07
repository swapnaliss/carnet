// The public payee status route against a real database (M3-06): headers, uniform 404, guessing,
// rate limit, expiry, revocation, disclosure mapping, no financial fields, hashed token, no outbound
// call.
import http from "node:http";
import https from "node:https";
import {
  createCounterparty,
  createPayeeLink,
  createPayment,
  type Db,
  getBusiness,
  insertRfi,
  repoCtx,
  revokePayeeLink,
  schema,
  updatePaymentTransfer,
  updateRfi,
} from "@carnet/db";
import {
  type DisclosureLevel,
  money,
  type PaymentId,
  TRANSFER_STATUSES,
  type TransferStatus,
} from "@carnet/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hashPayeeToken, holdingRfi, newPayeeToken } from "../../src/server/payee-status";
import { createPayeeStatusHandler } from "../../src/server/payee-status-handler";
import { setupAuthTestEnv } from "../auth/setup";

const env = setupAuthTestEnv();
const ORIGIN = "http://localhost:3100";
const REFERENCE = "INV-SECRET-REF-7731";
const COUNTERPARTY = "Acme Nordic Printing AB";
const RFI_TEXT = "Describe the purpose of this payment";

let paymentId: PaymentId;
let userId: string;
let businessName = "";
let ipCounter = 0;
const freshIp = () => `198.51.100.${(++ipCounter % 250) + 1}`;
const HIGH_LIMIT = { PAYEE_STATUS_RATE_LIMIT_PER_MIN: "1000000" };

let held = false;
let now = new Date();
function handler(options: { env?: Record<string, string>; openRfi?: boolean } = {}) {
  return createPayeeStatusHandler({
    db: () => env().db,
    logger: () => env().rt.logger,
    now: () => now,
    openRfi: async () => options.openRfi ?? held,
    env: options.env ?? HIGH_LIMIT,
  });
}

function get(token: string, ip = freshIp(), method = "GET") {
  return new Request(`${ORIGIN}/status/${token}`, {
    method,
    headers: { "x-forwarded-for": ip },
  });
}
const call = (h: ReturnType<typeof handler>, token: string, ip?: string) =>
  h(get(token, ip), { params: Promise.resolve({ token }) });

async function makeLink(
  level: DisclosureLevel = "GENERIC",
  options: { expiresInMs?: number; db?: Db } = {},
): Promise<{ token: string; id: string }> {
  const token = newPayeeToken();
  const ctx = repoCtx(options.db ?? env().db, env().businessId);
  const link = await createPayeeLink(ctx, {
    paymentId,
    tokenHash: hashPayeeToken(token),
    expiresAt: new Date(now.getTime() + (options.expiresInMs ?? 3_600_000)),
    disclosureLevel: level,
    createdBy: userId as never,
  });
  if (!link) throw new Error("link not created");
  return { token, id: link.id };
}

async function setTransfer(status: TransferStatus | null) {
  await env()
    .db.update(schema.payments)
    .set({
      transferStatus: status,
      transferUpdatedAt: status ? new Date("2026-11-06T09:30:00Z") : null,
      transferId: status ? `tr_${status}_${Math.random().toString(36).slice(2)}` : null,
    })
    .where(eq(schema.payments.id, paymentId));
}

beforeAll(async () => {
  const { db, businessId } = env();
  const ctx = repoCtx(db, businessId);
  const [user] = await db.select().from(schema.users).where(eq(schema.users.role, "owner"));
  if (!user) throw new Error("no owner");
  userId = user.id;
  businessName = (await getBusiness(ctx))?.name ?? "";
  const cp = await createCounterparty(ctx, { name: COUNTERPARTY, country: "SE" });
  const payment = await createPayment(ctx, {
    counterpartyId: cp.id,
    amount: money(987_654_321n, "USD"),
    sourceCurrency: "USD",
    method: "SWIFT",
    reference: REFERENCE,
  });
  paymentId = payment.id;
  await updatePaymentTransfer(ctx, paymentId, {
    transferId: "tr_seed_1",
    transferStatus: "PROCESSING",
    transferUpdatedAt: new Date("2026-11-06T09:30:00Z"),
  });
});

afterEach(() => {
  held = false;
  now = new Date();
});

const PRIVACY = {
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function expectPrivacyHeaders(res: Response) {
  for (const [name, value] of Object.entries(PRIVACY))
    expect(res.headers.get(name), name).toBe(value);
  expect(res.headers.get("set-cookie")).toBeNull();
}

describe("headers", () => {
  it("a live link answers 200 with the privacy headers and no cookie", async () => {
    const { token } = await makeLink();
    const res = await call(handler(), token);
    expect(res.status).toBe(200);
    expectPrivacyHeaders(res);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  });

  it("an unknown token answers 404 with the same headers", async () => {
    const res = await call(handler(), newPayeeToken());
    expect(res.status).toBe(404);
    expectPrivacyHeaders(res);
  });

  it("a limited caller answers 429 with the same headers and retry-after", async () => {
    const h = handler({ env: { PAYEE_STATUS_RATE_LIMIT_PER_MIN: "1" } });
    const ip = freshIp();
    await call(h, newPayeeToken(), ip);
    const res = await call(h, newPayeeToken(), ip);
    expect(res.status).toBe(429);
    expectPrivacyHeaders(res);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});

const tokenCounters = async () =>
  (
    await env()
      .db.select()
      .from(schema.rateLimits)
      .where(sql`${schema.rateLimits.key} like 'payee_status:token:%'`)
  ).length;

describe("token guessing", () => {
  it("10,000 random tokens: only 404, one identical body, and no payee_links row created or changed", async () => {
    const h = handler();
    const ip = freshIp();
    await makeLink();
    const countersBefore = await tokenCounters();
    const rowsBefore = JSON.stringify(await env().db.select().from(schema.payeeLinks));
    const statuses = new Set<number>();
    const bodies = new Set<string>();
    const batch = 100;
    for (let i = 0; i < 10_000; i += batch) {
      const results = await Promise.all(
        Array.from({ length: batch }, async () => {
          const res = await call(h, newPayeeToken(), ip);
          return { status: res.status, body: await res.text() };
        }),
      );
      for (const r of results) {
        statuses.add(r.status);
        bodies.add(r.body);
      }
    }
    expect([...statuses]).toEqual([404]);
    expect(bodies.size).toBe(1);
    expect(JSON.stringify(await env().db.select().from(schema.payeeLinks))).toBe(rowsBefore);
    // Guesses are counted per caller only: one counter row, none per guessed token.
    const counters = await tokenCounters();
    expect(counters).toBe(countersBefore);
  }, 180_000);

  it("malformed and oversized tokens get the same 404 body as a well-formed unknown one", async () => {
    const h = handler();
    const reference = await (await call(h, newPayeeToken())).text();
    for (const token of ["x", "%00", "a".repeat(5000), "../etc/passwd", "ÿ".repeat(43)]) {
      const res = await call(h, token);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(reference);
    }
  });

  it("the limiter engages after the limit and returns 429; another caller is unaffected", async () => {
    const h = handler({ env: { PAYEE_STATUS_RATE_LIMIT_PER_MIN: "3" } });
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await call(h, newPayeeToken(), ip)).status);
    expect(codes).toEqual([404, 404, 404, 429, 429]);
    expect((await call(h, newPayeeToken(), freshIp())).status).toBe(404);
  });

  it("a live link is also limited by its own hash prefix, across callers", async () => {
    const h = handler({ env: { PAYEE_STATUS_RATE_LIMIT_PER_MIN: "2" } });
    const { token } = await makeLink();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await call(h, token, freshIp())).status);
    expect(codes).toEqual([200, 200, 429, 429]);
  });
});

describe("expired and revoked links", () => {
  it("answer exactly like an unknown token", async () => {
    const h = handler();
    const unknown = await call(h, newPayeeToken());
    const unknownBody = await unknown.text();

    const expired = await makeLink("GENERIC", { expiresInMs: 1000 });
    now = new Date(now.getTime() + 2000);
    const expiredRes = await call(h, expired.token);
    now = new Date(now.getTime() - 2000);

    const revoked = await makeLink();
    await revokePayeeLink(repoCtx(env().db, env().businessId), paymentId, revoked.id);
    const revokedRes = await call(h, revoked.token);

    for (const res of [expiredRes, revokedRes]) {
      expect(res.status).toBe(unknown.status);
      expect(await res.text()).toBe(unknownBody);
      expect([...res.headers.keys()].sort()).toEqual([...unknown.headers.keys()].sort());
    }
  });

  it("revocation takes effect immediately", async () => {
    const h = handler();
    const { token, id } = await makeLink();
    expect((await call(h, token)).status).toBe(200);
    await revokePayeeLink(repoCtx(env().db, env().businessId), paymentId, id);
    expect((await call(h, token)).status).toBe(404);
  });

  it("only a live view records last_viewed_at", async () => {
    const h = handler();
    const { token, id } = await makeLink();
    const read = async () =>
      (await env().db.select().from(schema.payeeLinks).where(eq(schema.payeeLinks.id, id)))[0]
        ?.lastViewedAt;
    expect(await read()).toBeNull();
    await call(h, token);
    expect(await read()).toBeInstanceOf(Date);
  });
});

describe("what the payee sees", () => {
  it("a held payment: GENERIC reads Processing, the opt-in link reads Delayed for verification, SENT reads Sent on both", async () => {
    const generic = await makeLink("GENERIC");
    const delayed = await makeLink("DELAYED_FOR_VERIFICATION");
    const word = async (token: string) => {
      const body = await (await call(handler({ openRfi: true }), token)).text();
      return /class="word [a-z]+">([^<]+)</.exec(body)?.[1];
    };
    await setTransfer("PROCESSING");
    expect(await word(generic.token)).toBe("Processing");
    expect(await word(delayed.token)).toBe("Delayed for verification");
    await setTransfer("SENT");
    expect(await word(generic.token)).toBe("Sent");
    expect(await word(delayed.token)).toBe("Sent");
  });

  it("a held GENERIC page is byte-identical to an unheld one", async () => {
    await setTransfer("PROCESSING");
    const { token } = await makeLink("GENERIC");
    const a = await (await call(handler({ openRfi: true }), token)).text();
    const b = await (await call(handler({ openRfi: false }), token)).text();
    expect(a).toBe(b);
  });

  it("is total over all eleven transfer statuses end to end", async () => {
    const expected: Record<TransferStatus, string> = {
      IN_APPROVAL: "Processing",
      APPROVAL_RECALLED: "Failed",
      APPROVAL_REJECTED: "Failed",
      APPROVAL_BLOCKED: "Failed",
      SCHEDULED: "Processing",
      OVERDUE: "Processing",
      PROCESSING: "Processing",
      SENT: "Sent",
      PAID: "Paid",
      FAILED: "Failed",
      CANCELLED: "Failed",
    };
    const { token } = await makeLink("GENERIC");
    for (const status of TRANSFER_STATUSES) {
      await setTransfer(status);
      const body = await (await call(handler(), token)).text();
      expect(/class="word [a-z]+">([^<]+)</.exec(body)?.[1], status).toBe(expected[status]);
    }
    await setTransfer("PROCESSING");
  });

  it("shows the time the transfer last changed", async () => {
    await setTransfer("PAID");
    const { token } = await makeLink();
    const body = await (await call(handler(), token)).text();
    expect(body).toContain('<time datetime="2026-11-06T09:30:00.000Z">');
    await setTransfer("PROCESSING");
  });

  it("contains no amount, currency, payee, reference, business, RFI text or id", async () => {
    await setTransfer("PAID");
    const { token, id } = await makeLink("DELAYED_FOR_VERIFICATION");
    const res = await call(handler({ openRfi: true }), token);
    const body = await res.text();
    const forbidden = [
      REFERENCE,
      COUNTERPARTY,
      businessName,
      RFI_TEXT,
      "USD",
      "9,876,543",
      "987654321",
      "9876543",
      paymentId,
      id,
      env().businessId,
      token,
      hashPayeeToken(token),
      "tr_",
    ];
    for (const value of forbidden) {
      if (value) expect(body, value).not.toContain(value);
    }
    // The response headers carry none of them either.
    const headerText = [...res.headers.entries()].flat().join("\n");
    for (const value of forbidden) if (value) expect(headerText, value).not.toContain(value);
    await setTransfer("PROCESSING");
  });
});

describe("the token is stored hashed", () => {
  it("the raw token is in no column of any row, and the hash is 64 hex characters", async () => {
    const { token, id } = await makeLink();
    const [row] = await env()
      .db.select()
      .from(schema.payeeLinks)
      .where(eq(schema.payeeLinks.id, id));
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.tokenHash).toBe(hashPayeeToken(token));
    for (const [column, value] of Object.entries(row ?? {})) {
      expect(String(value), column).not.toContain(token);
    }
    // And in no row of any other table the feature writes to.
    for (const table of [schema.auditLog, schema.idempotencyKeys, schema.rateLimits]) {
      const rows = await env().db.select().from(table);
      expect(
        JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      ).not.toContain(token);
    }
  });
});

describe("no outbound call", () => {
  it("viewing a link makes no HTTP request", async () => {
    const spies = [
      vi.spyOn(globalThis, "fetch"),
      vi.spyOn(http, "request"),
      vi.spyOn(https, "request"),
    ];
    const { token } = await makeLink();
    await call(handler(), token);
    await call(handler(), newPayeeToken());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
  });
});

describe("wired to the rfis table (M2-04)", () => {
  it("a linked RFI in a holding state shows the opt-in wording; once it is closed the link reads Processing", async () => {
    await setTransfer("PROCESSING");
    const ctx = repoCtx(env().db, env().businessId);
    const rfi = await insertRfi(ctx, {
      airwallexRfiId: `rfi-payee-${Date.now()}`,
      type: "TRANSACTION",
      subType: null,
      airwallexStatus: "ACTION_REQUIRED",
      airwallexUpdatedAt: new Date(),
      airwallexAnsweredRequests: 0,
      state: "DRAFTING",
      round: 1,
      expiresAt: null,
      paymentId,
      orphanReason: null,
      linkedBy: "match",
      sourceKey: `TRANSFER:payee-${Date.now()}`,
      conflict: false,
    });
    const generic = await makeLink("GENERIC");
    const delayed = await makeLink("DELAYED_FOR_VERIFICATION");
    const real = createPayeeStatusHandler({
      db: () => env().db,
      logger: () => env().rt.logger,
      now: () => now,
      openRfi: holdingRfi,
      env: HIGH_LIMIT,
    });
    const word = async (token: string) =>
      /class="word [a-z]+">([^<]+)</.exec(await (await call(real, token)).text())?.[1];
    expect(await word(generic.token)).toBe("Processing");
    expect(await word(delayed.token)).toBe("Delayed for verification");
    await updateRfi(ctx, rfi.id, { state: "CLOSED" });
    expect(await word(delayed.token)).toBe("Processing");
  });
});
