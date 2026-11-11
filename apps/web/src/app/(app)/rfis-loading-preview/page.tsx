import { notFound } from "next/navigation";
import { HoldSkeleton } from "@/components/rfi/hold-skeleton";

export const dynamic = "force-dynamic";

/**
 * Renders the hold screen's loading state (rfis/[id]/loading.tsx) for the accessibility check and
 * design review; a streamed loading boundary cannot be held open by a test. Off unless the server runs
 * with CARNET_ERROR_PREVIEW=1 (set only by playwright.config.ts); otherwise a plain 404.
 */
export default function LoadingPreview() {
  if (process.env.CARNET_ERROR_PREVIEW !== "1") notFound();
  return <HoldSkeleton />;
}
