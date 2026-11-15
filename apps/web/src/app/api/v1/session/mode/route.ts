// The session's mode (M4-05, ADR 0018 amendment 2). The mode is a server-side attribute of the
// session row; no cookie, query or header changes it.
//   GET  /api/v1/session/mode   any signed-in user: { mode, can_switch }
//   PUT  /api/v1/session/mode   { mode: "live" | "replay" }, the owner only (403 for the approver and
//                               the judge). Allowed from replay so the owner can switch back to live.
import { setSessionMode } from "@carnet/db";
import { z } from "zod";
import { defineRoute } from "../../../../../lib/define-route";
import { forbidden } from "../../../../../lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store" } as const;

export const GET = defineRoute({
  method: "GET",
  auth: "session",
  handler: async ({ ctx }) =>
    Response.json({ mode: ctx.mode, can_switch: ctx.role === "owner" }, { headers: NO_STORE }),
});

export const PUT = defineRoute({
  method: "PUT",
  auth: { roles: ["owner"] },
  allowInReplay: true,
  body: z.strictObject({ mode: z.enum(["live", "replay"]) }),
  handler: async ({ ctx, repo, body }) => {
    if (!ctx.sessionId) throw forbidden();
    if (!(await setSessionMode(repo.db, ctx.sessionId, body.mode))) throw forbidden();
    return Response.json({ mode: body.mode, can_switch: true }, { headers: NO_STORE });
  },
});
