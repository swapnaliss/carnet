// AC: in production the session cookie is HttpOnly, SameSite=Lax and Secure. (A file of its own:
// each file gets one test database.)
import { describe, expect, it } from "vitest";
import { setupAuthTestEnv, signIn } from "./setup";

const prod = setupAuthTestEnv({ production: true });

describe("sign-in in production", () => {
  it("the session cookie is also Secure", async () => {
    const res = await signIn(prod(), "owner@carnet.example", prod().passwords.owner);
    expect(res.status).toBe(200);
    const session = res.headers.getSetCookie().find((c) => c.includes("session_token="));
    const attributes = (session ?? "").split(";").map((a) => a.trim().toLowerCase());
    expect(attributes).toEqual(expect.arrayContaining(["httponly", "samesite=lax", "secure"]));
  });
});
