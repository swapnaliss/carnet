// Shared setup for the auth integration tests: a per-worker test database (packages/db harness),
// the three seeded demo users with random passwords, and a runtime whose logs are captured.
// The handlers are the same ones /api/auth/[...all]/route.ts exports, built on this runtime.
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { createUser, type Db, repoCtx, schema, seedDemoUsers, type UserRole } from "@carnet/db";
import type { BusinessId, UserId } from "@carnet/domain";
import { hashPassword } from "better-auth/crypto";
import { beforeAll } from "vitest";
// Renamed on import: outside packages/db the linter treats `use*` as a React hook.
import { useTestDatabase as testDatabase } from "../../../../packages/db/test/harness";
import {
  type AuthHandlers,
  type AuthRuntime,
  createAuthHandlers,
  createAuthRuntime,
} from "../../src/lib/auth";
import { type Authz, createAuthz } from "../../src/lib/authz";
import { createLogger } from "../../src/lib/logger";

export const ORIGIN = "http://localhost:3100";

export interface AuthTestEnv {
  readonly db: Db;
  readonly rt: AuthRuntime;
  readonly handlers: AuthHandlers;
  readonly authz: Authz;
  /** Every log line the runtime wrote, as raw JSON text. */
  readonly logs: string[];
  readonly passwords: { owner: string; approver: string; judge: string };
  readonly businessId: BusinessId;
  /** Moves the rate limiter's clock. */
  setNow(date: Date): void;
}

export function setupAuthTestEnv(options: { production?: boolean } = {}): () => AuthTestEnv {
  const database = testDatabase();
  let env: AuthTestEnv | undefined;

  beforeAll(async () => {
    const db = database().app.db;
    const passwords = {
      owner: randomBytes(12).toString("hex"),
      approver: randomBytes(12).toString("hex"),
      judge: randomBytes(12).toString("hex"),
    };
    const seeded = await seedDemoUsers(db, {
      env: {
        SEED_OWNER_PASSWORD: passwords.owner,
        SEED_APPROVER_PASSWORD: passwords.approver,
        SEED_JUDGE_PASSWORD: passwords.judge,
      },
    });
    const logs: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        logs.push(String(chunk));
        done();
      },
    });
    let now = new Date();
    const rt = createAuthRuntime({
      db,
      settings: {
        secret: randomBytes(32).toString("hex"),
        baseURL: ORIGIN,
        production: options.production ?? false,
      },
      logger: createLogger({ level: "debug" }, sink),
      now: () => now,
    });
    env = {
      db,
      rt,
      handlers: createAuthHandlers(() => rt),
      authz: createAuthz(() => rt),
      logs,
      passwords,
      businessId: seeded.businessId,
      setNow(date) {
        now = date;
      },
    };
  });

  return () => {
    if (!env) throw new Error("auth test env is not ready");
    return env;
  };
}

export function jsonRequest(
  path: string,
  body: unknown,
  init: { ip?: string | undefined; cookie?: string | undefined; method?: string } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json", origin: ORIGIN });
  headers.set("x-forwarded-for", init.ip ?? "203.0.113.10");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export function getRequest(path: string, cookie?: string): Request {
  const headers = new Headers({ origin: ORIGIN });
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { method: "GET", headers });
}

/** The `name=value` pairs of a response's Set-Cookie headers, joined for a Cookie header. */
export function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export async function signIn(
  env: AuthTestEnv,
  email: string,
  password: string,
  ip?: string,
): Promise<Response> {
  return env.handlers.POST(jsonRequest("/api/auth/sign-in/email", { email, password }, { ip }));
}

/** Signs in and returns the Cookie header value; throws unless the sign-in succeeded. */
export async function sessionCookie(env: AuthTestEnv, email: string, password: string) {
  const res = await signIn(env, email, password, `198.51.100.${Math.floor(Math.random() * 200)}`);
  if (res.status !== 200) throw new Error(`sign-in for ${email} failed with ${res.status}`);
  return cookieOf(res);
}

/** Adds a user with a password to any business (a second tenant for the cross-tenant test). */
export async function addUser(
  db: Db,
  businessId: BusinessId,
  input: { email: string; role: UserRole; password: string },
): Promise<UserId> {
  const user = await createUser(repoCtx(db, businessId), {
    email: input.email,
    name: input.email,
    role: input.role,
  });
  await db.insert(schema.authAccounts).values({
    userId: user.id,
    accountId: user.id,
    providerId: "credential",
    password: await hashPassword(input.password),
  });
  return user.id;
}
