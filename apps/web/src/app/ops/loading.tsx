import { PageTitle } from "@/components/shell/empty-state";
import { t } from "@/strings";

// Loading state (docs/design/screens/ops.md): section and card skeletons at their final size and
// grid (3 service-level cards, 4 worker cards, 2 payment cards), and a polite status line.
const SECTIONS = [
  { key: "slo", cards: 3, grid: "md:grid-cols-3" },
  { key: "health", cards: 4, grid: "sm:grid-cols-2 xl:grid-cols-4" },
  { key: "money", cards: 2, grid: "sm:grid-cols-2" },
] as const;

export default function OpsLoading() {
  return (
    <>
      <PageTitle>{t.ops.title}</PageTitle>
      <div className="flex flex-col gap-8">
        <p role="status" className="text-sm text-muted-foreground">
          {t.ops.loading.status}
        </p>
        {SECTIONS.map((section) => (
          <div key={section.key} aria-hidden="true" className="flex flex-col gap-3">
            <div className="h-6 w-48 animate-pulse rounded-sm bg-muted" />
            <div className={`grid gap-4 ${section.grid}`}>
              {Array.from({ length: section.cards }, (_, i) => `${section.key}-${i}`).map((k) => (
                <div
                  key={k}
                  className="h-60 animate-pulse rounded-md border border-border bg-muted motion-reduce:animate-none"
                />
              ))}
            </div>
          </div>
        ))}
        <div aria-hidden="true" className="flex flex-col gap-3">
          <div className="h-6 w-56 animate-pulse rounded-sm bg-muted" />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="h-28 rounded-md border border-dashed border-border" />
            <div className="h-28 rounded-md border border-dashed border-border" />
          </div>
        </div>
      </div>
    </>
  );
}
