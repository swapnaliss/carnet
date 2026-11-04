import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Renders the page-level error state (error.tsx) for the accessibility check and design review.
 * Off unless the server runs with CARNET_ERROR_PREVIEW=1 (set only by playwright.config.ts); otherwise
 * this route is a plain 404, so production never exposes it.
 */
export default function ErrorPreview(): never {
  if (process.env.CARNET_ERROR_PREVIEW !== "1") notFound();
  throw new Error("error-preview: deliberate failure to render the page-level error state");
}
