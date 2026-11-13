// POST /api/ops/flags (M4-02): the owner's kill switches.
//
//   Body  { flag: "agents_enabled" | "execution_enabled", enabled: boolean, reason?: string }
//   200   { flag, enabled, changed }   `changed` is false when the switch already had that value
//   401 no session · 403 any role but owner (no audit entry, no change) · 400 invalid body
//
// The owner role is enforced by defineRoute before the handler runs. The route takes JSON only (415
// otherwise) and the session cookie is SameSite, so a cross-site form cannot post to it. One audit
// entry (actor, old and new value, reason) is written in the same transaction as the change.
import { setSwitch } from "@carnet/db";
import { z } from "zod";
import type { AuthRule, RouteSpec } from "../lib/define-route";

type Schema = z.ZodType | undefined;
const routeSpec = <A extends AuthRule, B extends Schema, Q extends Schema, P extends Schema>(
  spec: RouteSpec<A, B, Q, P>,
) => spec;

export const FlagBodySchema = z.strictObject({
  flag: z.enum(["agents_enabled", "execution_enabled"]),
  enabled: z.boolean(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export const flagsSpec = routeSpec({
  method: "POST",
  auth: { roles: ["owner"] as const },
  body: FlagBodySchema,
  maxBodyBytes: 4 * 1024,
  rateLimit: { name: "approval", by: "user" },
  handler: async ({ ctx, repo, body }) => {
    const result = await setSwitch(repo, {
      flag: body.flag,
      value: body.enabled,
      actorId: ctx.userId,
      reason: body.reason,
    });
    return Response.json(
      { flag: result.flag, enabled: result.after, changed: result.changed },
      { headers: { "cache-control": "no-store" } },
    );
  },
});
