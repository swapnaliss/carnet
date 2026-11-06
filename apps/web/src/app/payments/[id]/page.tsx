import { getPayment, repoCtx } from "@carnet/db";
import { PaymentIdSchema, project } from "@carnet/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PayeeLinksPanel } from "@/components/payee/payee-links-panel";
import { PageTitle } from "@/components/shell/empty-state";
import { formatMoney } from "@/lib/intl";
import { requirePageSession } from "@/lib/page-session";
import { appDb } from "@/server/db";
import { defaultPayeeLinkTtlHours } from "@/server/payee-status";
import { locale, t } from "@/strings";

export const metadata: Metadata = { title: t.payee.page.title };
export const dynamic = "force-dynamic";

// The payment page (M3-06 hosts the payee-link panel; M2-08 and later add evidence and the hold).
// The status shown is projected from the transfer (ADR 0006); the open-RFI input arrives with M2-04.
export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePageSession();
  const parsed = PaymentIdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();
  const payment = await getPayment(repoCtx(appDb().db, session.businessId), parsed.data);
  if (!payment) notFound();
  const view = payment.transferStatus ? project(payment.transferStatus, false).view : null;
  return (
    <>
      <Link
        href="/queue"
        className="mb-4 inline-flex min-h-11 items-center text-sm underline underline-offset-4 md:min-h-9"
      >
        {t.payee.page.back}
      </Link>
      <PageTitle>{t.payee.page.title}</PageTitle>
      <dl className="mb-8 grid max-w-2xl gap-x-6 gap-y-3 sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted-foreground">{t.payee.page.reference}</dt>
        <dd>{payment.reference}</dd>
        <dt className="text-muted-foreground">{t.payee.page.amount}</dt>
        <dd className="font-mono">{formatMoney(payment.amount, locale)}</dd>
        <dt className="text-muted-foreground">{t.payee.page.status}</dt>
        <dd>{view ? t.payee.page.view[view] : t.payee.page.noTransfer}</dd>
      </dl>
      <PayeeLinksPanel
        paymentId={payment.id}
        canManage={session.role !== "viewer"}
        defaultHours={defaultPayeeLinkTtlHours()}
      />
    </>
  );
}
