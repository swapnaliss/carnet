import { t } from "@/strings";

// Loading state (docs/design/screens/plan-screen.md "Loading"): the headline, two action cards, the
// balances and the obligations as skeletons with a polite status line, so nothing shifts on arrival.
const pulse = "animate-pulse bg-muted motion-reduce:animate-none";

function Block({ className }: { className: string }) {
  return <div className={`rounded-sm ${pulse} ${className}`} />;
}

export function PlanSkeleton() {
  return (
    <>
      <p role="status" className="mb-4 text-sm text-muted-foreground">
        {t.plan.loading.status}
      </p>
      <div aria-hidden="true" className="flex flex-col gap-6">
        <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-6">
          <Block className="h-7 w-1/2" />
          <Block className="h-5 w-3/4" />
          <Block className="h-4 w-2/3" />
        </div>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[7fr_5fr]">
          <div className="flex flex-col gap-3">
            <Block className="h-40" />
            <Block className="h-40" />
          </div>
          <div className="flex flex-col gap-3">
            <Block className="h-48" />
            <Block className="h-48" />
          </div>
        </div>
      </div>
    </>
  );
}
