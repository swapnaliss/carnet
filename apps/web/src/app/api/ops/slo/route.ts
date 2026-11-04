// GET /api/ops/slo: the token-protected SLO summary for the scheduled health check (M1-09,
// src/server/ops.ts has the contract). Declared through defineRoute as "public" for session auth:
// the bearer token (OPS_CHECK_TOKEN) is checked inside, and the route takes no input.
import { defineRoute } from "../../../../lib/define-route";
import { appDb } from "../../../../server/db";
import { createSloHandler } from "../../../../server/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const slo = createSloHandler({ db: () => appDb().db });

export const GET = defineRoute({ method: "GET", auth: "public", handler: ({ req }) => slo(req) });
