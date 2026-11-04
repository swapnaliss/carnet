import { PageTitle } from "@/components/shell/empty-state";
import { t } from "@/strings";

const CARDS = ["a", "b", "c", "d", "e", "f"] as const;

// Loading state (docs/design/screens/ops.md): card skeletons at their final size.
export default function OpsLoading() {
  return (
    <>
      <PageTitle>{t.ops.title}</PageTitle>
      <p role="status" className="sr-only">
        {t.ops.loading.status}
      </p>
      <div aria-hidden="true" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {CARDS.map((k) => (
          <div key={k} className="h-44 animate-pulse rounded-md border border-border bg-muted" />
        ))}
      </div>
    </>
  );
}
