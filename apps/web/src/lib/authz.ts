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
import type { BusinessId, ErrorCode, UserId } from "@carnet/domain";
import { type AuthRuntime, errorResponse, getAuthRuntime, requestIdOf } from "./auth";

export type Role = UserRole;

export interface AuthCtx {
  readonly businessId: BusinessId;
  readonly userId: UserId;
  readonly role: Role;
}

/** A refusal a guard or handler throws; `guarded` turns it into the shared error format. */
export class HttpProblem extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "HttpProblem";
    this.code = code;
  }
}

export const unauthenticated = () => new HttpProblem("UNAUTHENTICATED", "Sign in to continue.");
export const forbidden = () =>
  new HttpProblem("FORBIDDEN", "Your role does not allow this action.");
/** Also the answer for another business's resource: never 403, never data. */
export const notFound = () => new HttpProblem("NOT_FOUND", "Not found.");

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
  return { businessId: businessId as BusinessId, userId: id as UserId, role };
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
    guarded(guard, handler) {
      return async (req, route) => {
        const requestId = requestIdOf(req);
        try {
          const ctx = await guard(req);
          return await handler(req, ctx, route);
        } catch (error) {
          if (error instanceof HttpProblem) {
            return errorResponse(error.code, error.message, requestId);
          }
          runtime().logger.error(
            {
              event: "route.error",
              requestId,
              err: error instanceof Error ? error.message : "unknown",
            },
            "route handler failed",
          );
          return errorResponse("INTERNAL", "Something went wrong.", requestId);
        }
      };
    },
  };
}

/** The process-wide guards (route handlers import these). */
export const authz: Authz = createAuthz(getAuthRuntime);
export const { requireSession, requireRole, repo, guarded } = authz;
