import { t } from "@/strings";

// Loading state (docs/design/screens/evidence-view.md): the header, the tab bar and five check rows as
// skeletons, with a polite status line, so nothing shifts when the evidence arrives.
const pulse = "animate-pulse bg-muted motion-reduce:animate-none";

export default function EvidenceLoading() {
  return (
    <>
      <p role="status" className="mb-4 text-sm text-muted-foreground">
        {t.evidence.loading.status}
      </p>
      <div aria-hidden="true" className="flex flex-col gap-6">
        <div className={`h-6 w-40 rounded-sm ${pulse}`} />
        <div className="flex flex-col gap-3">
          <div className={`h-8 w-2/3 rounded-sm ${pulse}`} />
          <div className={`h-7 w-56 rounded-sm ${pulse}`} />
          <div className={`h-12 max-w-[70ch] rounded-sm ${pulse}`} />
        </div>
        <div className="flex gap-2 border-b border-border pb-2">
          <div className={`h-9 w-24 rounded-sm ${pulse}`} />
          <div className={`h-9 w-32 rounded-sm ${pulse}`} />
        </div>
        <div className="overflow-hidden rounded-md border border-border bg-card">
          {["a", "b", "c", "d", "e"].map((k) => (
            <div key={k} className="flex h-14 items-center gap-4 border-b border-border px-4">
              <div className={`h-4 w-1/4 rounded-sm ${pulse}`} />
              <div className={`h-4 w-20 rounded-sm ${pulse}`} />
              <div className={`h-4 flex-1 rounded-sm ${pulse}`} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
