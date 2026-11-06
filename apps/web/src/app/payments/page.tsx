import type { Metadata } from "next";
import { CreatePaymentForm } from "@/components/payments/create-payment-form";
import { PaymentList } from "@/components/payments/payment-list";
import { PageTitle } from "@/components/shell/empty-state";
import { repo } from "@/lib/authz";
import { requirePageSession } from "@/lib/page-session";
import { loadPaymentList } from "@/server/payments";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.payments.title };
export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
  const ctx = await requirePageSession();
  const initial = await loadPaymentList(repo(ctx));
  const canCreate = ctx.role === "owner";
  return (
    <>
      <PageTitle>{t.payments.title}</PageTitle>
      <div className="flex flex-col gap-6">
        <p className="max-w-[65ch] text-muted-foreground">{t.payments.intro}</p>
        {canCreate ? <CreatePaymentForm /> : <p className="text-sm">{t.payments.readOnly}</p>}
        <PaymentList initial={initial} canCreate={canCreate} />
      </div>
    </>
  );
}
