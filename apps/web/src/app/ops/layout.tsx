import { forbidden } from "next/navigation";
import type { ReactNode } from "react";
import { requirePageSession } from "@/lib/page-session";

export const dynamic = "force-dynamic";

// The /ops role check (M1-09) lives in the layout, outside the loading boundary, so the 403 status
// is decided before the page starts streaming: owner and approver pass, a viewer gets `forbidden()`
// (HTTP 403, app/forbidden.tsx), and no session redirects to /login.
export default async function OpsLayout({ children }: { children: ReactNode }) {
  const ctx = await requirePageSession();
  if (ctx.role === "viewer") forbidden();
  return children;
}
