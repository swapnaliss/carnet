import { PaymentIdSchema } from "@carnet/domain";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PaymentDetail } from "@/components/payments/payment-detail";
import { repo } from "@/lib/authz";
import { requirePageSession } from "@/lib/page-session";
import { loadPaymentDetail } from "@/server/payments";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.payments.list.title };
export const dynamic = "force-dynamic";

export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePageSession();
  const parsed = PaymentIdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();
  const initial = await loadPaymentDetail(repo(ctx), parsed.data, ctx.role);
  if (!initial) notFound();
  return <PaymentDetail initial={initial} canSimulate={ctx.role === "owner"} />;
}
