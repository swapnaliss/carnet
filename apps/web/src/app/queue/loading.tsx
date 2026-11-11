import { PageTitle } from "@/components/shell/empty-state";
import { t } from "@/strings";

// Loading state (docs/design/states.md): the title, a polite status line and skeletons shaped like the
// summary, the filter chips and the table rows, so nothing shifts when the data arrives.
const pulse = "animate-pulse bg-muted motion-reduce:animate-none";

export default function QueueLoading() {
  return (
    <>
      <PageTitle>{t.queue.title}</PageTitle>
      <p role="status" className="mb-4 text-sm text-muted-foreground">
        {t.queue.loading.status}
      </p>
      <div aria-hidden="true" className="flex flex-col gap-6">
        <div className={`h-6 w-80 max-w-full rounded-sm ${pulse}`} />
        <div className="flex flex-wrap gap-2">
          {["a", "b", "c", "d"].map((k) => (
            <div key={k} className={`h-11 w-24 rounded-md md:h-9 ${pulse}`} />
          ))}
        </div>
        <div className="hidden overflow-hidden rounded-md border border-border bg-card xl:block">
          <div className="h-10 border-b border-border bg-muted" />
          {["a", "b", "c", "d", "e"].map((k) => (
            <div key={k} className="flex h-14 items-center gap-4 border-b border-border px-4">
              <div className={`h-4 w-1/4 rounded-sm ${pulse}`} />
              <div className={`ml-auto h-4 w-20 rounded-sm ${pulse}`} />
              <div className={`h-6 w-28 rounded-sm ${pulse}`} />
              <div className={`h-6 w-28 rounded-sm ${pulse}`} />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-3 xl:hidden">
          {["a", "b", "c", "d"].map((k) => (
            <div
              key={k}
              className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
            >
              <div className="flex justify-between">
                <div className={`h-4 w-1/2 rounded-sm ${pulse}`} />
                <div className={`h-4 w-20 rounded-sm ${pulse}`} />
              </div>
              <div className={`h-3 w-1/3 rounded-sm ${pulse}`} />
              <div className="flex gap-2">
                <div className={`h-6 w-28 rounded-sm ${pulse}`} />
                <div className={`h-6 w-28 rounded-sm ${pulse}`} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
