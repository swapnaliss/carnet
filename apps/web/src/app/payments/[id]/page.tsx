import { PaymentIdSchema } from "@carnet/domain";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PayeeLinksPanel } from "@/components/payee/payee-links-panel";
import { PaymentDetail } from "@/components/payments/payment-detail";
import { repo } from "@/lib/authz";
import { requirePageSession } from "@/lib/page-session";
import { defaultPayeeLinkTtlHours } from "@/server/payee-status";
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
  return (
    <>
      <PaymentDetail initial={initial} canSimulate={ctx.role === "owner"} />
      {/* Payee status links (M3-06): the owner copies the link; Carnet sends nothing. */}
      <div className="mt-10">
        <PayeeLinksPanel
          paymentId={parsed.data}
          canManage={ctx.role !== "viewer"}
          defaultHours={defaultPayeeLinkTtlHours()}
        />
      </div>
    </>
  );
}
