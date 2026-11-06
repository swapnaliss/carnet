// POST /api/v1/documents (M2-01): upload one PDF, JPEG or PNG as multipart `file` with an optional
// `kind`. The contract, limits and order of checks are in src/server/documents/routes.ts.
import { defineRoute } from "../../../../lib/define-route";
import { logger } from "../../../../lib/logger";
import { documentRouteSpecs } from "../../../../server/documents/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const specs = documentRouteSpecs({ logger: () => logger() });

export const POST = defineRoute(specs.upload);
