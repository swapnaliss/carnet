import { PageTitle } from "@/components/shell/empty-state";
import { t } from "@/strings";

// Loading state (docs/design/states.md): the page title, a polite status line, and skeletons shaped
// like the final layout (intro, create form, table header and rows) so nothing shifts when data arrives.
const pulse = "animate-pulse bg-muted motion-reduce:animate-none";

export default function PaymentsLoading() {
  return (
    <>
      <PageTitle>{t.payments.title}</PageTitle>
      <p role="status" className="mb-4 text-sm text-muted-foreground">
        {t.payments.loading}
      </p>
      <div aria-hidden="true" className="flex flex-col gap-6">
        <div className={`h-12 max-w-[65ch] rounded-sm ${pulse}`} />
        <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-4 md:p-6">
          <div className={`h-6 w-56 rounded-sm ${pulse}`} />
          <div className="grid gap-4 md:grid-cols-[12rem_1fr_auto]">
            <div className={`h-20 rounded-sm ${pulse}`} />
            <div className={`h-20 rounded-sm ${pulse}`} />
            <div className={`h-11 w-full rounded-md md:w-40 ${pulse}`} />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className={`h-6 w-32 rounded-sm ${pulse}`} />
          <div className="overflow-hidden rounded-md border border-border bg-card">
            <div className="h-10 border-b border-border bg-muted" />
            {["a", "b", "c", "d"].map((k) => (
              <div key={k} className="flex h-14 items-center gap-4 border-b border-border px-4">
                <div className={`h-4 w-1/3 rounded-sm ${pulse}`} />
                <div className={`ml-auto h-4 w-20 rounded-sm ${pulse}`} />
                <div className={`h-6 w-28 rounded-sm ${pulse}`} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
