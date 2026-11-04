// AC: role matrix (viewer 403 on a POST guarded by requireRole("owner","approver"), approver and
// owner pass, unauthenticated 401) and cross-tenant isolation (business A asking for business B's
// resource id gets 404: not 403, not data). The routes are built from the real guards and the real
// tenant repositories, the way product route handlers are.
import {
  type Counterparty,
  createBusiness,
  createCounterparty,
  getCounterparty,
  repoCtx,
} from "@carnet/db";
import { ApiErrorSchema, type CounterpartyId } from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { notFound } from "../../src/lib/authz";
import { addUser, getRequest, jsonRequest, sessionCookie, setupAuthTestEnv } from "./setup";

const env = setupAuthTestEnv();

const cookies: Record<"owner" | "approver" | "judge" | "otherOwner", string> = {
  owner: "",
  approver: "",
  judge: "",
  otherOwner: "",
};
let ownCounterparty: Counterparty;
let foreignCounterparty: Counterparty;

beforeAll(async () => {
  const { db, passwords, businessId } = env();
  cookies.owner = await sessionCookie(env(), "owner@carnet.example", passwords.owner);
  cookies.approver = await sessionCookie(env(), "approver@carnet.example", passwords.approver);
  cookies.judge = await sessionCookie(env(), "judge@carnet.example", passwords.judge);

  const otherBusiness = await createBusiness(db, { name: "Other business (synthetic)" });
  await addUser(db, otherBusiness, {
    email: "owner@other.example",
    role: "owner",
    password: "other-owner-password",
  });
  cookies.otherOwner = await sessionCookie(env(), "owner@other.example", "other-owner-password");

  ownCounterparty = await createCounterparty(repoCtx(db, businessId), {
    name: "Own supplier",
    country: "SG",
  });
  foreignCounterparty = await createCounterparty(repoCtx(db, otherBusiness), {
    name: "Other supplier",
    country: "GB",
  });
});

/** POST /api/test/approve: the shape of an approval route. */
function approveRoute() {
  const { guarded, requireRole } = env().authz;
  return guarded(requireRole("owner", "approver"), async (_req, ctx) =>
    Response.json({ approvedBy: ctx.userId, role: ctx.role }),
  );
}

/** GET /api/test/counterparties/[id]: reads one resource through the session's tenant scope. */
function counterpartyRoute() {
  const { guarded, requireSession, repo } = env().authz;
  return guarded<{ params: { id: string } }>(requireSession, async (_req, ctx, { params }) => {
    const found = await getCounterparty(repo(ctx), params.id as CounterpartyId);
    if (!found) throw notFound();
    return Response.json({ id: found.id, name: found.name });
  });
}

async function errorCode(res: Response): Promise<string> {
  return ApiErrorSchema.parse(await res.json()).error.code;
}

describe("role matrix: POST guarded by requireRole('owner', 'approver')", () => {
  const call = (cookie?: string) =>
    approveRoute()(jsonRequest("/api/test/approve", {}, { cookie }), undefined);

  it("viewer (the judge) gets 403 in the shared error format", async () => {
    const res = await call(cookies.judge);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("FORBIDDEN");
  });

  it("approver passes", async () => {
    const res = await call(cookies.approver);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: "approver" });
  });

  it("owner passes", async () => {
    const res = await call(cookies.owner);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: "owner" });
  });

  it("unauthenticated gets 401", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("UNAUTHENTICATED");
  });

  it("a forged or expired cookie is unauthenticated", async () => {
    const res = await call("carnet.session_token=forged.value");
    expect(res.status).toBe(401);
  });

  it("requireRole('owner') refuses the approver (settings routes)", async () => {
    const { guarded, requireRole } = env().authz;
    const settings = guarded(requireRole("owner"), async () => new Response(null, { status: 204 }));
    const res = await settings(
      jsonRequest("/api/test/settings", {}, { cookie: cookies.approver }),
      undefined,
    );
    expect(res.status).toBe(403);
    const ok = await settings(
      jsonRequest("/api/test/settings", {}, { cookie: cookies.owner }),
      undefined,
    );
    expect(ok.status).toBe(204);
  });
});

describe("viewer is read-only", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "%s through requireSession is 403",
    async (method) => {
      const { guarded, requireSession } = env().authz;
      const route = guarded(requireSession, async () => Response.json({ ok: true }));
      const res = await route(
        jsonRequest("/api/test/any", {}, { cookie: cookies.judge, method }),
        undefined,
      );
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("FORBIDDEN");
    },
  );

  it("GET through requireSession passes", async () => {
    const res = await counterpartyRoute()(
      getRequest(`/api/test/counterparties/${ownCounterparty.id}`, cookies.judge),
      { params: { id: ownCounterparty.id } },
    );
    expect(res.status).toBe(200);
  });
});

describe("cross-tenant", () => {
  it("business A reading business B's resource id gets 404, not 403, not data", async () => {
    const res = await counterpartyRoute()(
      getRequest(`/api/test/counterparties/${foreignCounterparty.id}`, cookies.owner),
      { params: { id: foreignCounterparty.id } },
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(ApiErrorSchema.parse(JSON.parse(text)).error.code).toBe("NOT_FOUND");
    expect(text).not.toContain("Other supplier");
    expect(text).not.toContain(foreignCounterparty.id);
  });

  it("the same route serves the owning business", async () => {
    const res = await counterpartyRoute()(
      getRequest(`/api/test/counterparties/${foreignCounterparty.id}`, cookies.otherOwner),
      { params: { id: foreignCounterparty.id } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Other supplier" });
  });

  it("the session context carries the business from the database, not from the request", async () => {
    const ctx = await env().authz.requireSession(
      getRequest("/api/test/whoami", cookies.otherOwner),
    );
    expect(ctx.businessId).not.toBe(env().businessId);
    expect(ctx.role).toBe("owner");
  });
});
