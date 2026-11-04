// AC: no password or session token appears in logs. Captures everything the auth runtime logs, plus
// anything written to stdout, stderr or the console, during successful and failed logins.
import { DEMO_USERS, schema } from "@carnet/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cookieOf, getRequest, setupAuthTestEnv, signIn } from "./setup";

const env = setupAuthTestEnv();

let captured: string[] = [];

beforeEach(() => {
  captured = [];
  const keep = (chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(keep);
  vi.spyOn(process.stderr, "write").mockImplementation(keep);
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth logs", () => {
  it("record logins without the password or the session token", async () => {
    const { passwords } = env();
    const ownerId = DEMO_USERS.find((u) => u.role === "owner")?.id ?? "";
    const ok = await signIn(env(), "owner@carnet.example", passwords.owner, "192.0.2.50");
    expect(ok.status).toBe(200);
    const cookie = cookieOf(ok);
    await env().handlers.GET(getRequest("/api/auth/get-session", cookie));
    const failed = await signIn(
      env(),
      "approver@carnet.example",
      `${passwords.owner}x`,
      "192.0.2.51",
    );
    expect(failed.status).toBe(401);

    const sessions = await env()
      .db.select({ token: schema.authSessions.token })
      .from(schema.authSessions)
      .where(eq(schema.authSessions.userId, ownerId));
    expect(sessions.length).toBeGreaterThan(0);

    const all = [...env().logs, ...captured].join("\n");
    // The logs are not empty: the login events are there.
    expect(env().logs.some((l) => l.includes('"event":"auth.login.succeeded"'))).toBe(true);
    expect(env().logs.some((l) => l.includes('"event":"auth.login.failed"'))).toBe(true);

    const secrets = [
      passwords.owner,
      `${passwords.owner}x`,
      ...sessions.map((s) => s.token),
      decodeURIComponent(cookie.split("=").slice(1).join("=")),
      cookie,
    ];
    for (const secret of secrets) expect(all).not.toContain(secret);
  });

  it("the redaction list censors credentials a caller logs by mistake", () => {
    const { rt, logs } = env();
    rt.logger.info(
      {
        password: "p-123456",
        body: { password: "p-234567", token: "t-1" },
        headers: { cookie: "c-1", authorization: "Bearer a-1" },
      },
      "careless",
    );
    const line = logs.at(-1) ?? "";
    expect(line).toContain("careless");
    for (const value of ["p-123456", "p-234567", "t-1", "c-1", "a-1"]) {
      expect(line).not.toContain(value);
    }
  });
});
