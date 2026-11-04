import { healthPayload } from "../../health";
import { withRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export const GET = withRequestContext(() =>
  Response.json(healthPayload(), { headers: { "cache-control": "no-store" } }),
);
