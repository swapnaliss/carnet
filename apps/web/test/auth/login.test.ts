// AC: valid credentials create an HttpOnly, SameSite=Lax session cookie; invalid credentials answer
// 401 in the shared error format with no hint whether the email exists.
import { ApiErrorSchema } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import { cookieOf, getRequest, jsonRequest, signIn, useAuthTestEnv } from "./setup";

const env = useAuthTestEnv();

describe("sign-in", () => {
  it("valid credentials set an HttpOnly, SameSite=Lax session cookie and return no token", async () => {
    const res = await signIn(env(), "owner@carnet.example", env().passwords.owner);
    expect(res.status).toBe(200);

    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("carnet.session_token="));
    expect(session, cookies.join("\n")).toBeDefined();
    const attributes = (session as string).split(";").map((a) => a.trim().toLowerCase());
    expect(attributes).toContain("httponly");
    expect(attributes).toContain("samesite=lax");
    expect(attributes).toContain("path=/");
    expect(attributes).not.toContain("secure"); // development; production is covered below

    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["user"]);
    expect(body.user).toMatchObject({ email: "owner@carnet.example", role: "owner" });
    expect(JSON.stringify(body)).not.toContain((session as string).split("=")[1]?.split(".")[0]);

    // The cookie is a working session.
    const me = await env().handlers.GET(getRequest("/api/auth/get-session", cookieOf(res)));
    expect(me.status).toBe(200);
    const data = (await me.json()) as { user: { businessId: string; role: string } };
    expect(data.user).toMatchObject({ businessId: env().businessId, role: "owner" });
  });

  it("a wrong password and an unknown email give the same 401 in the shared error format", async () => {
    const wrong = await signIn(env(), "approver@carnet.example", "not-the-password", "192.0.2.1");
    const unknown = await signIn(env(), "nobody@carnet.example", "not-the-password", "192.0.2.2");

    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.headers.getSetCookie()).toEqual([]);
      const body: unknown = await res.json();
      const parsed = ApiErrorSchema.parse(body);
      expect(parsed.error.code).toBe("UNAUTHENTICATED");
      expect(parsed.error.message).toBe("Email or password is incorrect.");
      expect(parsed.error.details).toBeUndefined();
      expect(res.headers.get("x-request-id")).toBe(parsed.error.request_id);
    }
  });

  it("a malformed body is a 400 in the shared error format", async () => {
    const res = await env().handlers.POST(
      jsonRequest("/api/auth/sign-in/email", { email: "owner@carnet.example" }),
    );
    expect(res.status).toBe(400);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("sign-out ends the session", async () => {
    const login = await signIn(env(), "judge@carnet.example", env().passwords.judge, "192.0.2.3");
    const cookie = cookieOf(login);
    const out = await env().handlers.POST(jsonRequest("/api/auth/sign-out", {}, { cookie }));
    expect(out.status).toBe(200);
    const me = await env().handlers.GET(getRequest("/api/auth/get-session", cookie));
    expect(await me.json()).toBeNull();
  });
});
