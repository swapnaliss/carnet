// POST /api/v1/rfis/{id}/drafts: an owner edit becomes a new draft (spec in src/server/hold.ts).
import { defineRoute } from "../../../../../../lib/define-route";
import { ownerDraftSpec } from "../../../../../../server/hold";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defineRoute(ownerDraftSpec);
