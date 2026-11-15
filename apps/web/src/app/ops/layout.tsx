import { forbidden } from "next/navigation";
import type { ReactNode } from "react";
import { requirePageSession } from "@/lib/page-session";

export const dynamic = "force-dynamic";

// The /ops role check (M1-09) lives in the layout, outside the loading boundary, so the 403 status
// is decided before the page starts streaming: owner and approver pass, and no session redirects to
// /login. A viewer passes only in replay mode (M4-05: the judge reads /ops of the recording, read-only;
// a viewer is always replay, so this is the judge path); otherwise `forbidden()` (HTTP 403).
export default async function OpsLayout({ children }: { children: ReactNode }) {
  const ctx = await requirePageSession();
  if (ctx.role === "viewer" && ctx.mode !== "replay") forbidden();
  return children;
}
