import { PaymentIdSchema } from "@carnet/domain";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EvidenceView } from "@/components/evidence/evidence-view";
import { repo } from "@/lib/authz";
import { requirePageSession } from "@/lib/page-session";
import { loadEvidenceCheck } from "@/server/evidence";
import { loadPaymentDetail } from "@/server/payments";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.evidence.pageTitle };
export const dynamic = "force-dynamic";

// The evidence view (M2-03), built to docs/design/screens/evidence-view.md. Another business's payment
// is a 404 (the repositories are scoped by business).
export default async function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageSession();
  const parsed = PaymentIdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();
  const scoped = repo(ctx);
  const [check, detail] = await Promise.all([
    loadEvidenceCheck(scoped, parsed.data),
    loadPaymentDetail(scoped, parsed.data, ctx.role),
  ]);
  if (!check || !detail) notFound();
  return (
    <EvidenceView initial={check.dto} initialPayment={detail} canEdit={ctx.role === "owner"} />
  );
}
