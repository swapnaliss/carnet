import { PageTitle } from "@/components/shell/empty-state";
import { t } from "@/strings";

export default function PaymentLoading() {
  return (
    <>
      <PageTitle>{t.payee.page.title}</PageTitle>
      <p role="status" className="mb-4 text-sm text-muted-foreground">
        {t.payee.page.loading}
      </p>
      <div aria-hidden="true" className="flex max-w-2xl flex-col gap-3">
        <div className="h-6 w-64 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
        <div className="h-48 animate-pulse rounded-md border border-border bg-muted motion-reduce:animate-none" />
      </div>
    </>
  );
}
