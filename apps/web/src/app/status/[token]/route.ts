// The public payee status page (M3-06). See server/payee-status-handler.ts for the contract.

import { logger } from "../../../lib/logger";
import { withRequestContext } from "../../../lib/request-context";
import { appDb } from "../../../server/db";
import { holdingRfi } from "../../../server/payee-status";
import { createPayeeStatusHandler } from "../../../server/payee-status-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createPayeeStatusHandler({
  db: () => appDb().db,
  logger: () => logger(),
  now: () => new Date(),
  openRfi: holdingRfi,
});

export const GET = withRequestContext(handler);
