import { t } from "@/strings";

const block = "animate-pulse rounded-md bg-muted motion-reduce:animate-none";

/** Loading state at final height: header, deadline line and three question rows (no layout shift). */
export function HoldSkeleton() {
  return (
    <div aria-busy="true" data-testid="hold-skeleton" className="flex flex-col gap-6">
      <p role="status" className="sr-only">
        {t.hold.loading.status}
      </p>
      <div className="flex flex-col gap-3" aria-hidden="true">
        <div className={`${block} h-5 w-24`} />
        <div className={`${block} h-8 w-72 max-w-full`} />
        <div className={`${block} h-10 w-56`} />
        <div className="flex gap-2">
          <div className={`${block} h-7 w-44`} />
          <div className={`${block} h-7 w-28`} />
        </div>
        <div className={`${block} h-5 w-96 max-w-full`} />
      </div>
      <div className="flex flex-col gap-4" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="grid gap-4 rounded-md border border-border bg-card p-4 md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] md:p-6"
          >
            <div className="flex flex-col gap-3">
              <div className={`${block} h-6 w-3/4`} />
              <div className={`${block} h-4 w-full`} />
              <div className={`${block} h-16 w-full`} />
            </div>
            <div className={`${block} h-32 w-full`} />
          </div>
        ))}
      </div>
    </div>
  );
}
