// GET /api/v1/documents/{id} (M2-01): the stored bytes as an attachment, with the type detected at
// upload, `nosniff` and `private, no-store`. Another business's id is 404.
import { defineRoute } from "../../../../../lib/define-route";
import { logger } from "../../../../../lib/logger";
import { documentRouteSpecs } from "../../../../../server/documents/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const specs = documentRouteSpecs({ logger: () => logger() });

export const GET = defineRoute(specs.download);
