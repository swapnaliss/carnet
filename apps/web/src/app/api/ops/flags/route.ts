// POST /api/ops/flags: the owner's kill switches (M4-02, src/server/ops-flags.ts has the contract).
import { defineRoute } from "../../../../lib/define-route";
import { flagsSpec } from "../../../../server/ops-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defineRoute(flagsSpec);
