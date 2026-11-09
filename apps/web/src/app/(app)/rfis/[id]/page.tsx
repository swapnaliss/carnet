import { getRfi } from "@carnet/db";
import { RfiIdSchema } from "@carnet/domain";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HoldScreen } from "@/components/rfi/hold-screen";
import { repo } from "@/lib/authz";
import { requirePageSession } from "@/lib/page-session";
import { loadHoldView } from "@/server/hold";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.rfis.title };
export const dynamic = "force-dynamic";

// The hold screen (M2-08, docs/design/screens/hold-screen.md). The first render is server-fetched; the
// client then polls GET /api/v1/rfis/{id}/hold. Another business's id reads as absent (404).
export default async function RfiPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageSession();
  const parsed = RfiIdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();
  const rc = repo(ctx);
  const rfi = await getRfi(rc, parsed.data);
  if (!rfi) notFound();
  return <HoldScreen initial={await loadHoldView(rc, rfi, ctx.role)} />;
}
