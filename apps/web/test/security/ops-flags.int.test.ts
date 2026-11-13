// M4-02: POST /api/ops/flags (the production spec on a route kit over real sessions). Only the owner
// may flip a switch; a refused call changes nothing and writes no audit entry; an owner call writes
// exactly one entry (actor, old and new value, reason) and the change is visible at once.
import { getSystemFlags, listAudit, repoCtx } from "@carnet/db";
import type { BusinessId } from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { createRouteKit, type RouteHandler } from "../../src/lib/define-route";
import { flagsSpec } from "../../src/server/ops-flags";
import { addUser, ORIGIN, sessionCookie, setupAuthTestEnv } from "../auth/setup";

const env = setupAuthTestEnv();
const cookies = { owner: "", approver: "", viewer: "" };
let post: RouteHandler;
let businessId: BusinessId;

beforeAll(async () => {
  const { db, passwords } = env();
  const kit = createRouteKit({
    authz: env().authz,
    db: () => db,
    logger: () => env().rt.logger,
    now: () => new Date(),
  });
  post = kit.defineRoute(flagsSpec);
  const pw = "flags-test-password";
  const owner = await sessionCookie(env(), "owner@carnet.example", passwords.owner);
  cookies.owner = owner;
  businessId = env().businessId;
  await addUser(db, businessId, { email: "app@flags.test", role: "approver", password: pw });
  await addUser(db, businessId, { email: "view@flags.test", role: "viewer", password: pw });
  cookies.approver = await sessionCookie(env(), "app@flags.test", pw);
  cookies.viewer = await sessionCookie(env(), "view@flags.test", pw);
});

function call(cookie: string | null, body: unknown) {
  return post(
    new Request(`${ORIGIN}/api/ops/flags`, {
      method: "POST",
      headers: {
        ...(cookie ? { cookie } : {}),
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

const rc = () => repoCtx(env().db, businessId);

describe("POST /api/ops/flags", () => {
  it("no session is 401, an approver and a viewer are 403; nothing changes and nothing is audited", async () => {
    const before = (await listAudit(rc(), 500)).length;
    const body = { flag: "execution_enabled", enabled: false };
    expect((await call(null, body)).status).toBe(401);
    expect((await call(cookies.approver, body)).status).toBe(403);
    expect((await call(cookies.viewer, body)).status).toBe(403);
    expect((await getSystemFlags(env().db)).executionEnabled).toBe(true);
    expect((await listAudit(rc(), 500)).length).toBe(before);
  });

  it("rejects an unknown flag, extra keys and a non-boolean value (400)", async () => {
    for (const body of [
      { flag: "daily_spend_cap", enabled: false },
      { flag: "agents_enabled", enabled: "no" },
      { flag: "agents_enabled", enabled: false, extra: 1 },
    ]) {
      expect((await call(cookies.owner, body)).status).toBe(400);
    }
    expect((await getSystemFlags(env().db)).agentsEnabled).toBe(true);
  });

  it("an owner toggle changes the switch and writes one audit entry", async () => {
    const before = (await listAudit(rc(), 500)).length;
    const res = await call(cookies.owner, {
      flag: "agents_enabled",
      enabled: false,
      reason: "model outage",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ flag: "agents_enabled", enabled: false, changed: true });
    expect((await getSystemFlags(env().db)).agentsEnabled).toBe(false);
    const entries = await listAudit(rc(), 500);
    expect(entries.length).toBe(before + 1);
    expect(entries[0]).toMatchObject({
      action: "system_flag.changed",
      subject: "agents_enabled",
      actorType: "user",
      data: { old: true, new: false, reason: "model outage" },
    });
    // Back on (also proves resume works and audits again).
    const back = await call(cookies.owner, { flag: "agents_enabled", enabled: true });
    expect(await back.json()).toMatchObject({ enabled: true, changed: true });
    expect((await listAudit(rc(), 500)).length).toBe(before + 2);
  });
});
