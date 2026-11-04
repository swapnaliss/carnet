// Authentication (ADR 0012, M1-04): better-auth 1.7.15 email-and-password sessions on the Drizzle
// adapter. better-auth's `user` model is the `users` table (business_id and role are additional
// fields the client can never set); sessions, credential accounts and verifications are the auth_*
// tables (packages/db/src/schema/auth.ts, migration 0002_auth).
//
// The `/api/auth/*` handlers wrap better-auth with Carnet's rules:
// - sign-up is refused (404) in every environment: users come from `seedDemoUsers`, and a user
//   without a business cannot exist;
// - sign-in is rate limited by the `rate_limits` counter (5 failures per email, 20 per IP, per 15
//   minutes), answers failures in the shared error format with one message whether or not the
//   email exists, and never returns the session token in the body (the cookie is HttpOnly);
// - better-auth's own in-memory limiter is off (one limiter, in the database).
import { createHash } from "node:crypto";
import {
  createDbClientFromEnv,
  type Db,
  hitRateLimit,
  peekRateLimit,
  type RateLimitRule,
  type RateLimitState,
  schema,
} from "@carnet/db";
import { type ApiError, apiError, type ErrorCode, httpStatusOf } from "@carnet/domain";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createLogger, type Logger, logger } from "./logger";
import {
  requestIdOf as baseRequestIdOf,
  currentContext,
  withRequestContext,
} from "./request-context";

export const AUTH_ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL"] as const;
export const AUTH_BASE_PATH = "/api/auth";
export const SESSION_COOKIE_PREFIX = "carnet";
/** Session lifetime and refresh interval, seconds. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60;

export const LOGIN_RATE_LIMITS = {
  email: { limit: 5, windowMs: 15 * 60 * 1000 },
  ip: { limit: 20, windowMs: 15 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

const MAX_LOGIN_BODY_BYTES = 8 * 1024;
const MIN_SECRET_LENGTH = 32;

export interface AuthSettings {
  readonly secret: string;
  readonly baseURL: string;
  /** `Secure` cookies; true when NODE_ENV is production. */
  readonly production: boolean;
}

/** Reads BETTER_AUTH_SECRET and BETTER_AUTH_URL; the error names keys, never values. */
export function authSettingsFromEnv(env: Record<string, string | undefined>): AuthSettings {
  const secret = env.BETTER_AUTH_SECRET ?? "";
  const baseURL = env.BETTER_AUTH_URL ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BETTER_AUTH_SECRET must be set (at least ${MIN_SECRET_LENGTH} characters)`);
  }
  if (!URL.canParse(baseURL)) throw new Error("BETTER_AUTH_URL must be an absolute URL");
  return { secret, baseURL, production: env.NODE_ENV === "production" };
}

function buildAuth(db: Db, settings: AuthSettings, log: Logger) {
  return betterAuth({
    appName: "Carnet",
    secret: settings.secret,
    baseURL: settings.baseURL,
    basePath: AUTH_BASE_PATH,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        users: schema.users,
        authSessions: schema.authSessions,
        authAccounts: schema.authAccounts,
        authVerifications: schema.authVerifications,
      },
    }),
    user: {
      modelName: "users",
      additionalFields: {
        businessId: { type: "string", required: true, input: false },
        role: { type: "string", required: true, input: false },
      },
    },
    session: {
      modelName: "authSessions",
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    account: { modelName: "authAccounts" },
    verification: { modelName: "authVerifications" },
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 8 },
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    advanced: {
      database: { generateId: "uuid" },
      cookiePrefix: SESSION_COOKIE_PREFIX,
      useSecureCookies: settings.production,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: settings.production },
    },
    // Only the message is logged: better-auth's extra arguments can carry request data.
    logger: {
      level: "warn",
      log: (level, message) => log[level]({ source: "better-auth" }, message),
    },
  });
}

export type Auth = ReturnType<typeof buildAuth>;

export interface AuthRuntime {
  readonly auth: Auth;
  readonly db: Db;
  readonly logger: Logger;
  readonly settings: AuthSettings;
  /** Clock for the rate limiter (tests move it). */
  readonly now: () => Date;
}

export function createAuthRuntime(input: {
  db: Db;
  settings: AuthSettings;
  logger?: Logger;
  now?: () => Date;
}): AuthRuntime {
  const log = (input.logger ?? createLogger()).child({ component: "auth" });
  return {
    auth: buildAuth(input.db, input.settings, log),
    db: input.db,
    logger: log,
    settings: input.settings,
    now: input.now ?? (() => new Date()),
  };
}

let shared: AuthRuntime | undefined;

/** The process-wide runtime from the environment (DATABASE_URL, BETTER_AUTH_*), built on first use. */
export function getAuthRuntime(): AuthRuntime {
  shared ??= createAuthRuntime({
    db: createDbClientFromEnv(process.env).db,
    settings: authSettingsFromEnv(process.env),
  });
  return shared;
}

// --- shared error responses ----------------------------------------------------------------------

/**
 * Carnet's correlation id (M1-09, ./request-context.ts): the current request's id inside
 * `withRequestContext`, else a well-formed incoming `x-request-id`, else a new one.
 */
export function requestIdOf(req: Request): string {
  return currentContext().request_id ?? baseRequestIdOf(req);
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  requestId: string,
  headers: Record<string, string> = {},
): Response {
  const body: ApiError = apiError(code, message, requestId);
  return Response.json(body, {
    status: httpStatusOf(code),
    headers: { "cache-control": "no-store", "x-request-id": requestId, ...headers },
  });
}

// --- login rate limit ----------------------------------------------------------------------------

/**
 * The caller's IP for the per-IP counter: the first `x-forwarded-for` hop, else `x-real-ip`.
 * Behind the platform proxy these come from the proxy; M1-10 hardens which hop is trusted.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** `rate_limits.key` values for a login attempt. The email is lower-cased and hashed. */
export function loginRateLimitKeys(email: string, ip: string): { email: string; ip: string } {
  const digest = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  return { email: `login:email:${digest}`, ip: `login:ip:${ip}` };
}

function limitedResponse(states: RateLimitState[], requestId: string): Response | null {
  const limited = states.filter((s) => s.limited);
  if (limited.length === 0) return null;
  const retryAfter = Math.max(...limited.map((s) => s.retryAfterSeconds));
  return errorResponse(
    "RATE_LIMITED",
    "Too many failed sign-in attempts. Try again later.",
    requestId,
    { "retry-after": String(retryAfter) },
  );
}

// --- route handlers ------------------------------------------------------------------------------

const INVALID_CREDENTIALS = "Email or password is incorrect.";

function subPath(req: Request): string {
  const path = new URL(req.url).pathname;
  return path.startsWith(AUTH_BASE_PATH) ? path.slice(AUTH_BASE_PATH.length) : path;
}

function isSignUp(path: string): boolean {
  return path === "/sign-up" || path.startsWith("/sign-up/");
}

function readLoginBody(text: string): { email: string; password: string } | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { email, password } = value as Record<string, unknown>;
    if (typeof email !== "string" || typeof password !== "string") return null;
    if (email.length === 0 || email.length > 320 || password.length === 0) return null;
    return { email, password };
  } catch {
    return null;
  }
}

/** Copies only the Set-Cookie headers of a better-auth response. */
function cookieHeaders(res: Response): Headers {
  const out = new Headers({ "cache-control": "no-store" });
  for (const cookie of res.headers.getSetCookie()) out.append("set-cookie", cookie);
  return out;
}

async function signIn(rt: AuthRuntime, req: Request, requestId: string): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_LOGIN_BODY_BYTES) {
    return errorResponse("PAYLOAD_TOO_LARGE", "The request body is too large.", requestId);
  }
  const body = readLoginBody(text);
  if (!body) {
    return errorResponse("VALIDATION_FAILED", "Send an email and a password.", requestId);
  }

  const now = rt.now();
  const keys = loginRateLimitKeys(body.email, clientIp(req));
  const before = await Promise.all([
    peekRateLimit(rt.db, keys.email, LOGIN_RATE_LIMITS.email, now),
    peekRateLimit(rt.db, keys.ip, LOGIN_RATE_LIMITS.ip, now),
  ]);
  const refused = limitedResponse(before, requestId);
  if (refused) {
    rt.logger.warn({ event: "auth.login.rate_limited", requestId }, "login refused by rate limit");
    return refused;
  }

  const res = await rt.auth.handler(
    new Request(req.url, { method: "POST", headers: req.headers, body: text }),
  );

  if (res.ok) {
    const data = (await res.json()) as { user?: { id?: string; role?: string } };
    rt.logger.info(
      { event: "auth.login.succeeded", requestId, userId: data.user?.id, role: data.user?.role },
      "login succeeded",
    );
    // The token stays in the HttpOnly cookie; the body carries the user only.
    return Response.json({ user: data.user ?? null }, { status: 200, headers: cookieHeaders(res) });
  }

  if (res.status === 401) {
    await Promise.all([
      hitRateLimit(rt.db, keys.email, LOGIN_RATE_LIMITS.email, now),
      hitRateLimit(rt.db, keys.ip, LOGIN_RATE_LIMITS.ip, now),
    ]);
    rt.logger.info({ event: "auth.login.failed", requestId }, "login failed");
    return errorResponse("UNAUTHENTICATED", INVALID_CREDENTIALS, requestId);
  }

  rt.logger.warn({ event: "auth.login.error", requestId, status: res.status }, "login error");
  if (res.status === 400) {
    return errorResponse("VALIDATION_FAILED", "Send a valid email and password.", requestId);
  }
  if (res.status === 403) {
    return errorResponse("FORBIDDEN", "This sign-in request was refused.", requestId);
  }
  return errorResponse("INTERNAL", "Sign-in failed. Try again.", requestId);
}

export interface AuthHandlers {
  GET(req: Request): Promise<Response>;
  POST(req: Request): Promise<Response>;
}

export function createAuthHandlers(runtime: () => AuthRuntime): AuthHandlers {
  const handle = async (req: Request): Promise<Response> => {
    const requestId = requestIdOf(req);
    const path = subPath(req);
    if (isSignUp(path)) return errorResponse("NOT_FOUND", "Not found.", requestId);
    let rt: AuthRuntime | undefined;
    try {
      rt = runtime();
      if (req.method === "POST" && path === "/sign-in/email")
        return await signIn(rt, req, requestId);
      return await rt.auth.handler(req);
    } catch (error) {
      // Log the error class and message only; never the request.
      (rt?.logger ?? logger()).error(
        { event: "auth.error", requestId, err: error instanceof Error ? error.message : "unknown" },
        "auth handler failed",
      );
      return errorResponse("INTERNAL", "Authentication is unavailable.", requestId);
    }
  };
  const wrapped = withRequestContext(handle);
  return { GET: wrapped, POST: wrapped };
}
