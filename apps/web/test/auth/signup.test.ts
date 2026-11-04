// AC: the sign-up endpoint returns 404 (or 403) when NODE_ENV=production. Carnet refuses sign-up in
// every environment (users come from seedDemoUsers), so this also holds in development.
import { randomBytes } from "node:crypto";
import { schema } from "@carnet/db";
import { ApiErrorSchema } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import { authSettingsFromEnv, createAuthHandlers, createAuthRuntime } from "../../src/lib/auth";
import { jsonRequest, ORIGIN, setupAuthTestEnv } from "./setup";

const env = setupAuthTestEnv();

const countUsers = () => env().db.$count(schema.users);

const intruder = {
  email: "intruder@carnet.example",
  password: "intruder-password",
  name: "Intruder",
};

function handlersFor(nodeEnv: string) {
  const settings = authSettingsFromEnv({
    NODE_ENV: nodeEnv,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    BETTER_AUTH_URL: ORIGIN,
  });
  expect(settings.production).toBe(nodeEnv === "production");
  const rt = createAuthRuntime({ db: env().db, settings });
  return { rt, handlers: createAuthHandlers(() => rt) };
}

describe("sign-up", () => {
  it.each(["production", "development"])(
    "is 404 with NODE_ENV=%s and creates no user",
    async (nodeEnv) => {
      const { handlers } = handlersFor(nodeEnv);
      const before = await countUsers();
      for (const path of ["/api/auth/sign-up/email", "/api/auth/sign-up"]) {
        const res = await handlers.POST(jsonRequest(path, intruder));
        expect(res.status, path).toBe(404);
        expect(ApiErrorSchema.parse(await res.json()).error.code).toBe("NOT_FOUND");
      }
      expect(await countUsers()).toBe(before);
    },
  );

  it("is refused before the runtime is built (needs no database or secret)", async () => {
    const handlers = createAuthHandlers(() => {
      throw new Error("runtime must not be built for sign-up");
    });
    const res = await handlers.POST(jsonRequest("/api/auth/sign-up/email", {}));
    expect(res.status).toBe(404);
  });

  it("better-auth's own sign-up is disabled too (defence in depth)", async () => {
    const { rt } = handlersFor("production");
    const res = await rt.auth.handler(jsonRequest("/api/auth/sign-up/email", intruder));
    expect(res.ok).toBe(false);
    expect(await countUsers()).toBe(3);
  });
});
