import { healthPayload } from "../../health";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(healthPayload(), { headers: { "cache-control": "no-store" } });
}
