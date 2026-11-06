import { PageTitle } from "@/components/shell/empty-state";
import { t } from "@/strings";

export default function PaymentsLoading() {
  return (
    <>
      <PageTitle>{t.payments.title}</PageTitle>
      <p role="status" className="mb-4 text-sm text-muted-foreground">
        {t.payments.loading}
      </p>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <div className="h-40 animate-pulse rounded-md border border-border bg-muted motion-reduce:animate-none" />
        <div className="h-64 animate-pulse rounded-md border border-border bg-muted motion-reduce:animate-none" />
      </div>
    </>
  );
}
