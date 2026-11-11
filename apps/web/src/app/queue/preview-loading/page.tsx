import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

/** Holds this section's loading.tsx on screen for the design review. A plain 404 unless CARNET_ERROR_PREVIEW=1. */
export default async function PreviewLoading() {
  if (process.env.CARNET_ERROR_PREVIEW !== "1") notFound();
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  return null;
}
