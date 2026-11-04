// GET /api/ops/slo: the token-protected SLO summary for the scheduled health check (M1-09,
// src/server/ops.ts has the contract).
import { appDb } from "../../../../server/db";
import { createSloHandler } from "../../../../server/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createSloHandler({ db: () => appDb().db });
