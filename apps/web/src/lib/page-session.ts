// Session lookup for server components and pages (they have no Request object). Pages that need a
// signed-in user call `requirePageSession()`, which redirects to /login. Mutations never rely on
// this: they go through route handlers and the guards in authz.ts.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthRuntime } from "./auth";
import { type AuthCtx, sessionCtx } from "./authz";

export async function getPageSession(): Promise<AuthCtx | null> {
  return sessionCtx(getAuthRuntime(), await headers());
}

export async function requirePageSession(): Promise<AuthCtx> {
  const ctx = await getPageSession();
  if (!ctx) redirect("/login");
  return ctx;
}
