import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

/** Renders this section's error.tsx for the design review. A plain 404 unless CARNET_ERROR_PREVIEW=1. */
export default function PreviewError(): never {
  if (process.env.CARNET_ERROR_PREVIEW !== "1") notFound();
  throw new Error("preview: deliberate failure to render the section error state");
}
