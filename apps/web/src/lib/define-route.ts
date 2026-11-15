// Every API route handler is declared through `defineRoute` (M1-10, ADR 0004). It runs, in order:
//   1. authorisation (M1-04 guards): "public", "session" (any signed-in user; a viewer is refused on
//      a mutation) or { roles: [...] } → 401 / 403
//   2. the route's rate limit, if it names one (`{ name: "approval", by: "user" }`) → 429 + retry-after
//   3. input: path params, query and JSON body parsed with strict zod schemas (from packages/domain);
//      a body needs `Content-Type: application/json` (415) and fits the size cap (413); a route
//      without a body schema refuses a body (400). All field issues come back in one 400.
//   4. the handler, which gets typed, validated input only and is never called on invalid input
// A `multipart` route (M2-01 uploads) is the one body kind the handler reads itself, through
// `input.multipart()`: the handler counts its own caps and audits the outcome before the body is read.
// The reader still enforces the media type (415), a hard streamed byte cap whatever Content-Length
// says (413), and maps an unparseable body to 400.
// Anything thrown becomes the shared error format (lib/errors.ts); a 500 carries no internals.
//
// `defineRawRoute` is the documented raw-body variant for a route that must see the exact bytes (the
// Airwallex webhook verifies an HMAC over the raw body): rate limit, size cap and error mapping, no
// parsing. Only routes on `RAW_BODY_ROUTES` may skip `defineRoute` (test/security/routes.test.ts).
//
//   export const POST = defineRoute({
//     method: "POST",
//     auth: { roles: ["owner", "approver"] },
//     params: z.strictObject({ id: PaymentIdSchema }),
//     body: ApproveBodySchema,
//     rateLimit: { name: "approval", by: "user" },
//     handler: async ({ ctx, repo, params, body }) => Response.json(...),
//   });
import type { Db, RepoCtx } from "@carnet/db";
import { z } from "zod";
import { appDb } from "../server/db";
import { requestIdOf } from "./auth";
import { type AuthCtx, type Authz, authz as processAuthz, type Role } from "./authz";
import {
  type ErrorLog,
  type FieldIssue,
  fieldIssues,
  HttpProblem,
  payloadTooLarge,
  problemResponse,
  rateLimited,
  unsupportedMediaType,
  validationFailed,
} from "./errors";
import { logger } from "./logger";
import {
  clientIp,
  consumeRateLimit,
  ROUTE_RATE_LIMITS,
  type RouteRateLimitName,
  rateLimitKey,
} from "./ratelimit";
import { withRequestContext } from "./request-context";

/** Routes allowed to skip `defineRoute` (paths under src/app/api), each with its reason. */
export const RAW_BODY_ROUTES = {
  "webhooks/airwallex":
    "HMAC over the exact raw bytes before any parsing (ADR 0005); uses defineRawRoute",
  "auth/[...all]":
    "better-auth's handler owns parsing; lib/auth.ts adds size cap, validation and rate limit",
} as const;

/** The ceiling for any route's body, multipart uploads included (`maxBodyBytes` may only lower it). */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Default cap on JSON bodies when MAX_JSON_BODY_BYTES is unset. */
export const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;

export function maxJsonBodyBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MAX_JSON_BODY_BYTES);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_BODY_BYTES) : DEFAULT_MAX_JSON_BODY_BYTES;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type AuthRule = "public" | "session" | { readonly roles: readonly [Role, ...Role[]] };

type RouteParams = Record<string, string | string[] | undefined>;
/** The second argument Next.js passes to a route handler. */
export interface RouteContext {
  readonly params: Promise<RouteParams>;
}
export type RouteHandler = (req: Request, context?: RouteContext) => Promise<Response>;

type Schema = z.ZodType | undefined;

/** A `multipart/form-data` body kind: the whole body is at most `maxBytes()` (≤ MAX_BODY_BYTES). */
export interface MultipartSpec {
  readonly maxBytes: () => number;
}

export interface MultipartFile {
  readonly field: string;
  /** The client's filename, unsanitised: untrusted. */
  readonly name: string;
  /** The client's declared type: untrusted, never used to decide the type. */
  readonly declaredType: string;
  readonly bytes: Uint8Array;
}

export interface MultipartForm {
  readonly files: readonly MultipartFile[];
  readonly fields: readonly { readonly field: string; readonly value: string }[];
}

type Multipart = MultipartSpec | undefined;
type MultipartOf<M extends Multipart> = M extends MultipartSpec
  ? () => Promise<MultipartForm>
  : undefined;
type Out<S extends Schema> = S extends z.ZodType ? z.output<S> : undefined;
type CtxOf<A extends AuthRule> = A extends "public" ? null : AuthCtx;
type RepoOf<A extends AuthRule> = A extends "public" ? null : RepoCtx;

export interface RouteInput<
  A extends AuthRule,
  B extends Schema,
  Q extends Schema,
  P extends Schema,
  M extends Multipart = undefined,
> {
  readonly req: Request;
  readonly requestId: string;
  readonly ctx: CtxOf<A>;
  /** The tenant repository context (`repo(ctx)`), the only way to reach tenant data. */
  readonly repo: RepoOf<A>;
  readonly body: Out<B>;
  readonly query: Out<Q>;
  readonly params: Out<P>;
  /** Reads and parses the multipart body (only on a `multipart` route; call it at most once). */
  readonly multipart: MultipartOf<M>;
}

export interface RouteSpec<
  A extends AuthRule,
  B extends Schema,
  Q extends Schema,
  P extends Schema,
  M extends Multipart = undefined,
> {
  readonly method: HttpMethod;
  readonly auth: A;
  readonly body?: B;
  readonly query?: Q;
  readonly params?: P;
  /** Lowers the JSON body cap (MAX_JSON_BODY_BYTES, at most MAX_BODY_BYTES). */
  readonly maxBodyBytes?: number;
  /** A multipart/form-data body the handler reads with `input.multipart()` (exclusive with `body`). */
  readonly multipart?: M;
  readonly rateLimit?: { readonly name: RouteRateLimitName; readonly by: "user" | "ip" };
  /**
   * M4-05: a replay session is refused (403) on every mutation unless the route sets this; only the
   * owner's mode switch does (it needs `auth: { roles }`). judge-authz.test.ts lists the routes.
   */
  readonly allowInReplay?: true;
  readonly handler: (input: RouteInput<A, B, Q, P, M>) => Promise<Response>;
}

export interface RawRouteSpec {
  readonly method: HttpMethod;
  /** Body cap in bytes (at most MAX_BODY_BYTES). */
  readonly maxBodyBytes: number;
  readonly rateLimit?: { readonly name: RouteRateLimitName; readonly by: "ip" };
  readonly handler: (input: {
    readonly req: Request;
    readonly raw: Uint8Array;
    readonly requestId: string;
    /** When the request reached the route, before rate limit and body read (M1-09). */
    readonly receivedAt: Date;
  }) => Promise<Response>;
}

export interface RouteDeps {
  readonly authz: Authz;
  /** The database the rate limiter counts in. */
  readonly db: () => Db;
  readonly logger: () => ErrorLog;
  readonly now: () => Date;
}

// --- strict schemas --------------------------------------------------------------------------------

/** Throws at definition time unless every object in the schema rejects unknown keys. */
export function assertStrictSchema(schema: z.ZodType, label: string): void {
  const seen = new Set<unknown>();
  const visit = (s: z.ZodType, path: string): void => {
    if (seen.has(s)) return;
    seen.add(s);
    if (s instanceof z.ZodObject) {
      if (s.def.catchall?._zod.def.type !== "never") {
        throw new Error(
          `${label}: ${path || "(root)"} must be z.strictObject (unknown keys rejected)`,
        );
      }
      for (const [key, child] of Object.entries(s.def.shape)) {
        visit(child as z.ZodType, path ? `${path}.${key}` : key);
      }
      return;
    }
    const def = s.def as unknown as Record<string, unknown>;
    for (const field of ["in", "innerType", "element"]) {
      const child = def[field];
      if (child instanceof z.ZodType) visit(child, path);
    }
    if (Array.isArray(def.options)) {
      for (const option of def.options) if (option instanceof z.ZodType) visit(option, path);
    }
  };
  visit(schema, "");
}

// --- input -------------------------------------------------------------------------------------------

const JSON_TYPE = "application/json";

function mediaType(req: Request): string | null {
  const value = req.headers.get("content-type");
  return value ? (value.split(";")[0]?.trim().toLowerCase() ?? null) : null;
}

/** Reads at most `cap` bytes; a longer body is 413 without reading the rest. */
async function readCapped(req: Request, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > cap) throw payloadTooLarge();
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw payloadTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readJsonBody(req: Request, cap: number): Promise<unknown> {
  if (mediaType(req) !== JSON_TYPE) throw unsupportedMediaType(JSON_TYPE);
  const bytes = await readCapped(req, cap);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (text.trim() === "") {
    throw validationFailed([
      { location: "body", path: "", code: "required", message: "Send a JSON body." },
    ]);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw validationFailed([
      { location: "body", path: "", code: "invalid_json", message: "The body is not valid JSON." },
    ]);
  }
}

const MULTIPART_TYPE = "multipart/form-data";

/** Reads a multipart body under a hard cap and parses it; never trusts names or declared types. */
async function readMultipartBody(req: Request, maxBytes: number): Promise<MultipartForm> {
  const contentType = req.headers.get("content-type") ?? "";
  if (mediaType(req) !== MULTIPART_TYPE || !/;\s*boundary=/i.test(contentType)) {
    throw unsupportedMediaType(MULTIPART_TYPE);
  }
  const cap = Math.min(maxBytes, MAX_BODY_BYTES);
  const raw = await readCapped(req, cap);
  let form: FormData;
  try {
    // The body is already in memory and capped, so the platform parser cannot be made to buffer more.
    form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw validationFailed([
      {
        location: "body",
        path: "",
        code: "invalid_multipart",
        message: "The body is not valid multipart/form-data.",
      },
    ]);
  }
  const files: MultipartFile[] = [];
  const fields: { field: string; value: string }[] = [];
  for (const [field, value] of form.entries()) {
    if (typeof value === "string") {
      fields.push({ field, value });
      continue;
    }
    files.push({
      field,
      name: value.name,
      declaredType: value.type,
      bytes: new Uint8Array(await value.arrayBuffer()),
    });
  }
  return { files, fields };
}

async function refuseBody(req: Request): Promise<void> {
  if (!req.body) return;
  const bytes = await readCapped(req, 1024);
  if (bytes.byteLength > 0) {
    throw validationFailed([
      {
        location: "body",
        path: "",
        code: "unexpected_body",
        message: "This endpoint takes no body.",
      },
    ]);
  }
}

function queryObject(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    out[key] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return out;
}

function parseInto(
  schema: z.ZodType,
  value: unknown,
  location: FieldIssue["location"],
  issues: FieldIssue[],
): unknown {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  issues.push(...fieldIssues(location, result.error));
  return undefined;
}

// --- the factory ------------------------------------------------------------------------------------

function checkCap(cap: number, label: string): void {
  if (!Number.isInteger(cap) || cap <= 0 || cap > MAX_BODY_BYTES) {
    throw new Error(`${label}: maxBodyBytes must be an integer in 1..${MAX_BODY_BYTES}`);
  }
}

export function createRouteKit(deps: RouteDeps) {
  async function limit(
    rule: { name: RouteRateLimitName; by: "user" | "ip" },
    req: Request,
    ctx: AuthCtx | null,
  ): Promise<void> {
    const subject = rule.by === "user" ? ctx?.userId : clientIp(req);
    if (!subject) throw new Error("rate limit by user needs an authenticated route");
    const decision = await consumeRateLimit(
      deps.db(),
      rateLimitKey(rule.name, rule.by, subject),
      ROUTE_RATE_LIMITS[rule.name](),
      deps.now(),
    );
    if (!decision.allowed) throw rateLimited(decision.retryAfter);
  }

  function defineRoute<
    A extends AuthRule,
    B extends Schema = undefined,
    Q extends Schema = undefined,
    P extends Schema = undefined,
    M extends Multipart = undefined,
  >(spec: RouteSpec<A, B, Q, P, M>): RouteHandler {
    const label = `defineRoute(${spec.method})`;
    for (const [name, schema] of [
      ["body", spec.body],
      ["query", spec.query],
      ["params", spec.params],
    ] as const) {
      if (schema) assertStrictSchema(schema, `${label} ${name}`);
    }
    if (spec.maxBodyBytes !== undefined) checkCap(spec.maxBodyBytes, label);
    if (spec.rateLimit?.by === "user" && spec.auth === "public") {
      throw new Error(`${label}: a public route cannot be rate limited by user`);
    }
    if ((spec.body || spec.multipart) && (spec.method === "GET" || spec.method === "DELETE")) {
      throw new Error(`${label}: ${spec.method} takes no body`);
    }
    if (spec.body && spec.multipart) throw new Error(`${label}: body and multipart are exclusive`);
    if (spec.multipart && spec.auth === "public") {
      throw new Error(`${label}: a multipart (upload) route must be authenticated`);
    }
    if (spec.allowInReplay && (spec.auth === "public" || spec.auth === "session")) {
      throw new Error(`${label}: allowInReplay needs auth: { roles }`);
    }
    const roles = (spec.auth as { roles?: readonly Role[] }).roles ?? [];
    const guard =
      spec.auth === "public"
        ? null
        : spec.auth === "session"
          ? deps.authz.requireSession
          : spec.allowInReplay
            ? deps.authz.requireRoleAnyMode(...roles)
            : deps.authz.requireRole(...roles);

    // M1-09: the whole route runs in its correlation context (request_id on every log line, echoed
    // in x-request-id).
    return withRequestContext(async (req: Request, context?: RouteContext) => {
      const requestId = requestIdOf(req);
      try {
        const ctx = guard ? await guard(req) : null;
        if (spec.rateLimit) await limit(spec.rateLimit, req, ctx);

        const issues: FieldIssue[] = [];
        const params = spec.params
          ? parseInto(spec.params, (await context?.params) ?? {}, "params", issues)
          : undefined;
        const query = spec.query
          ? parseInto(spec.query, queryObject(new URL(req.url)), "query", issues)
          : undefined;
        let body: unknown;
        let multipart: (() => Promise<MultipartForm>) | undefined;
        if (spec.body) {
          const raw = await readJsonBody(req, spec.maxBodyBytes ?? maxJsonBodyBytes());
          body = parseInto(spec.body, raw, "body", issues);
        } else if (spec.multipart) {
          const { maxBytes } = spec.multipart;
          let read = false;
          multipart = () => {
            if (read) throw new Error("the multipart body was already read");
            read = true;
            return readMultipartBody(req, maxBytes());
          };
        } else {
          await refuseBody(req);
        }
        if (issues.length > 0) throw validationFailed(issues);

        return await spec.handler({
          req,
          requestId,
          ctx: ctx as CtxOf<A>,
          repo: (ctx ? deps.authz.repo(ctx) : null) as RepoOf<A>,
          body: body as Out<B>,
          query: query as Out<Q>,
          params: params as Out<P>,
          multipart: multipart as MultipartOf<M>,
        });
      } catch (error) {
        return problemResponse(error, requestId, deps.logger());
      }
    });
  }

  function defineRawRoute(spec: RawRouteSpec): RouteHandler {
    checkCap(spec.maxBodyBytes, `defineRawRoute(${spec.method})`);
    return withRequestContext(async (req: Request) => {
      // Arrival time, before the rate limit and the body read (M1-09 webhook ack latency).
      const receivedAt = new Date();
      const requestId = requestIdOf(req);
      try {
        if (spec.rateLimit) await limit(spec.rateLimit, req, null);
        const raw = await readCapped(req, spec.maxBodyBytes);
        return await spec.handler({ req, raw, requestId, receivedAt });
      } catch (error) {
        return problemResponse(error, requestId, deps.logger());
      }
    });
  }

  return { defineRoute, defineRawRoute };
}

/** The process-wide kit: M1-04 guards, the app database, the shared logger. */
export const { defineRoute, defineRawRoute } = createRouteKit({
  authz: processAuthz,
  db: () => appDb().db,
  logger: () => logger(),
  now: () => new Date(),
});

export { HttpProblem };
