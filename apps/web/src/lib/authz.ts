// Server-side authorisation (ADR 0012, M1-04). A route handler gets an `AuthCtx` only from these
// guards, and calls repositories only through `repo(ctx)`, which scopes every statement by the
// session's business. A resource of another business therefore reads as absent and answers 404.
//
// Role matrix:
//   owner     everything
//   approver  reads, and the routes guarded by requireRole("owner", "approver") (approvals); never
//             settings (guard those with requireRole("owner"))
//   viewer    read-only: any non-GET/HEAD request through these guards is 403 (the judge login)
import { type RepoCtx, repoCtx, USER_ROLES, type UserRole } from "@carnet/db";
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
  return {
    businessId: businessId as BusinessId,
    userId: id as UserId,
    role,
    sessionId: session.session.id,
  };
}

export function createAuthz(runtime: () => AuthRuntime): Authz {
  const requireSession: Guard = async (req) => {
    const ctx = await sessionCtx(runtime(), req.headers);
    if (!ctx) throw unauthenticated();
    if (ctx.role === "viewer" && !READ_METHODS.has(req.method.toUpperCase())) throw forbidden();
    return ctx;
  };

  return {
    requireSession,
    requireRole(...roles) {
      if (roles.length === 0) throw new Error("requireRole needs at least one role");
      return async (req) => {
        const ctx = await requireSession(req);
        if (!roles.includes(ctx.role)) throw forbidden();
        return ctx;
      };
    },
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
export const { requireSession, requireRole, repo, guarded } = authz;
