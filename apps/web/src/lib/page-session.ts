// Session lookup for server components and pages (they have no Request object). Pages that need a
// signed-in user call `requirePageSession()`, which redirects to /login. Mutations never rely on
// this: they go through route handlers and the guards in authz.ts.
//
// M4-05: in replay mode a page sees the session as a `viewer` (read-only UI: no create, approve or edit
// controls), because the API refuses every mutation from a replay session anyway. `getPageMode()`
// gives the shell the mode and whether this login may switch it (the owner only).
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuthRuntime } from "./auth";
import { type AuthCtx, sessionCtx } from "./authz";

const rawSession = cache(async (): Promise<AuthCtx | null> => {
  return sessionCtx(getAuthRuntime(), await headers());
});

export async function getPageSession(): Promise<AuthCtx | null> {
  const ctx = await rawSession();
  if (!ctx) return null;
  return ctx.mode === "replay" ? { ...ctx, role: "viewer" } : ctx;
}

export async function requirePageSession(): Promise<AuthCtx> {
  const ctx = await getPageSession();
  if (!ctx) redirect("/login");
  return ctx;
}

export interface PageMode {
  readonly mode: AuthCtx["mode"];
  /** True for the owner: the only login that may switch between the recording and live. */
  readonly canSwitch: boolean;
}

/** The session's mode for the shell; null when nobody is signed in. Never throws. */
export async function getPageMode(): Promise<PageMode | null> {
  try {
    const ctx = await rawSession();
    return ctx ? { mode: ctx.mode, canSwitch: ctx.role === "owner" } : null;
  } catch {
    return null;
  }
}
