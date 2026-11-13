import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Renders the plan's error state (plans/error.tsx) for the accessibility check and design review. Off
 * unless the server runs with CARNET_ERROR_PREVIEW=1 (set only by playwright.config.ts); otherwise a
 * plain 404, so production never exposes it.
 */
export default function PlanErrorPreview(): never {
  if (process.env.CARNET_ERROR_PREVIEW !== "1") notFound();
  throw new Error("plan error-preview: deliberate failure to render the plan error state");
}
