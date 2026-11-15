// Server-side authorisation (ADR 0012, M1-04). A route handler gets an `AuthCtx` only from these
// guards, and calls repositories only through `repo(ctx)`, which scopes every statement by the
// session's business. A resource of another business therefore reads as absent and answers 404.
//
// Role matrix:
//   owner     everything
//   approver  reads, and the routes guarded by requireRole("owner", "approver") (approvals); never
//             settings (guard those with requireRole("owner"))
//   viewer    read-only: any non-GET/HEAD request through these guards is 403 (the judge login)
//
// Session mode (M4-05, ADR 0018 amendment 2): `replay` or `live`, a server-side attribute of the session
// row (auth_sessions.mode), never a client flag. A viewer (the judge) is ALWAYS replay, whatever the row
// says. A replay session reads the replay business (REPLAY_BUSINESS_ID, the recorded runs) through the
// same repositories, and every non-GET request is 403 in replay, for every role, except the routes
// guarded by `requireRoleAnyMode` (the owner's switch back to live).
import {
  activeReplayBusinessId,
  type Db,
  REPLAY_BUSINESS_ID,
  type RepoCtx,
  repoCtx,
  type SessionMode,
  USER_ROLES,
  type UserRole,
} from "@carnet/db";
import type { BusinessId, UserId } from "@carnet/domain";
import { type AuthRuntime, getAuthRuntime, requestIdOf } from "./auth";
import { forbidden, problemResponse, unauthenticated } from "./errors";
import { withRequestContext } from "./request-context";

// The error helpers moved to ./errors (M1-10); re-exported so M1-04 call sites keep working.
export { forbidden, HttpProblem, notFound, unauthenticated } from "./errors";

export type Role = UserRole;

export interface AuthCtx {
  readonly businessId: BusinessId;
  readonly userId: UserId;
  readonly role: Role;
  /** The better-auth session row id (per-session upload caps, M2-01); absent outside a session. */
  readonly sessionId?: string;
  /** M4-05: `replay` reads the recording (businessId is then REPLAY_BUSINESS_ID); `live` the real one. */
  readonly mode: SessionMode;
  /** The user's own business, whatever the mode (businessId is the one every repository uses). */
  readonly homeBusinessId: BusinessId;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

export type Guard = (req: Request) => Promise<AuthCtx>;

export interface Authz {
  /** Any signed-in user; a viewer is refused (403) on a non-GET request. */
  requireSession: Guard;
  /** A signed-in user whose role is one of `roles` (and the viewer rule above). */
  requireRole(...roles: Role[]): Guard;
  /** As requireRole, but a replay session may mutate (only the mode switch uses it). */
  requireRoleAnyMode(...roles: Role[]): Guard;
  /** The tenant repository context for this session. */
  repo(ctx: AuthCtx): RepoCtx;
  /** Wraps a handler: runs the guard, maps HttpProblem to the shared error format. */
  guarded<P>(
    guard: Guard,
    handler: (req: Request, ctx: AuthCtx, route: P) => Promise<Response>,
  ): (req: Request, route: P) => Promise<Response>;
}

/** Reads the session from request headers. Returns null when there is none or it is unusable. */
export async function sessionCtx(rt: AuthRuntime, headers: Headers): Promise<AuthCtx | null> {
  const session = await rt.auth.api.getSession({ headers });
  if (!session) return null;
  const { id, businessId, role } = session.user as {
    id: string;
    businessId?: unknown;
    role?: unknown;
  };
  if (typeof businessId !== "string" || !isRole(role)) return null;
  const mode = effectiveMode(role, (session.session as { mode?: unknown }).mode);
  return {
    businessId: mode === "replay" ? await replayBusiness(rt.db) : (businessId as BusinessId),
    homeBusinessId: businessId as BusinessId,
    userId: id as UserId,
    role,
    sessionId: session.session.id,
    mode,
  };
}

// The replay business changes only on `npm run demo:reset`; a short cache spares a query per request.
const REPLAY_CACHE_MS = 10_000;
let replayCache: { at: number; id: BusinessId } | null = null;

async function replayBusiness(db: Db): Promise<BusinessId> {
  const now = Date.now();
  if (replayCache && now - replayCache.at < REPLAY_CACHE_MS) return replayCache.id;
  const id = await activeReplayBusinessId(db).catch(() => REPLAY_BUSINESS_ID);
  replayCache = { at: now, id };
  return id;
}

/** The judge (viewer) is always replay; anyone else is replay only when the session row says so. */
export function effectiveMode(role: Role, stored: unknown): SessionMode {
  if (role === "viewer") return "replay";
  return stored === "replay" ? "replay" : "live";
}

export function createAuthz(runtime: () => AuthRuntime): Authz {
  const anyMode = async (req: Request): Promise<AuthCtx> => {
    const ctx = await sessionCtx(runtime(), req.headers);
    if (!ctx) throw unauthenticated();
    if (ctx.role === "viewer" && !READ_METHODS.has(req.method.toUpperCase())) throw forbidden();
    return ctx;
  };
  const requireSession: Guard = async (req) => {
    const ctx = await anyMode(req);
    // M4-05: a recording is never changed, and nothing reaches Airwallex or the model from replay.
    if (ctx.mode === "replay" && !READ_METHODS.has(req.method.toUpperCase())) throw forbidden();
    return ctx;
  };
  const roleGuard = (base: Guard, roles: Role[]): Guard => {
    if (roles.length === 0) throw new Error("requireRole needs at least one role");
    return async (req) => {
      const ctx = await base(req);
      if (!roles.includes(ctx.role)) throw forbidden();
      return ctx;
    };
  };

  return {
    requireSession,
    requireRole: (...roles) => roleGuard(requireSession, roles),
    requireRoleAnyMode: (...roles) => roleGuard(anyMode, roles),
    repo: (ctx) => repoCtx(runtime().db, ctx.businessId),
    guarded<P>(guard: Guard, handler: (req: Request, ctx: AuthCtx, route: P) => Promise<Response>) {
      return withRequestContext(async (req: Request, route: P) => {
        const requestId = requestIdOf(req);
        try {
          const ctx = await guard(req);
          return await handler(req, ctx, route);
        } catch (error) {
          return problemResponse(error, requestId, runtime().logger);
        }
      });
    },
  };
}

/** The process-wide guards (route handlers import these). */
export const authz: Authz = createAuthz(getAuthRuntime);
export const { requireSession, requireRole, requireRoleAnyMode, repo, guarded } = authz;
