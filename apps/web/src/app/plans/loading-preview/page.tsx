import { notFound } from "next/navigation";
import { PlanSkeleton } from "@/components/plan/plan-skeleton";

export const dynamic = "force-dynamic";

/**
 * Renders the plan's loading state (plans/loading.tsx) for the accessibility check and design review; a
 * streamed loading boundary cannot be held open by a test. Off unless the server runs with
 * CARNET_ERROR_PREVIEW=1 (set only by playwright.config.ts); otherwise a plain 404.
 */
export default function PlanLoadingPreview() {
  if (process.env.CARNET_ERROR_PREVIEW !== "1") notFound();
  return <PlanSkeleton />;
}
