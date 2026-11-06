// GET /api/v1/documents/{id}/meta (M2-01): metadata only (DocumentMetaSchema in @carnet/domain).
import { defineRoute } from "../../../../../../lib/define-route";
import { logger } from "../../../../../../lib/logger";
import { documentRouteSpecs } from "../../../../../../server/documents/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const specs = documentRouteSpecs({ logger: () => logger() });

export const GET = defineRoute(specs.meta);
