import { PageTitle } from "@/components/shell/empty-state";
import { t } from "@/strings";

// Loading state (docs/design/states.md): the title, a polite status line and skeletons shaped like the
// controls and the timeline, so nothing shifts when the recording arrives.
const pulse = "animate-pulse bg-muted motion-reduce:animate-none";

export default function ReplayLoading() {
  return (
    <>
      <PageTitle>{t.replay.page.title}</PageTitle>
      <p role="status" className="mb-4 text-sm text-muted-foreground">
        {t.replay.page.loading}
      </p>
      <div aria-hidden="true" className="flex flex-col gap-4">
        <div className={`h-6 w-96 max-w-full rounded-sm ${pulse}`} />
        <div className="flex flex-wrap gap-2">
          {["a", "b", "c", "d", "e"].map((k) => (
            <div key={k} className={`h-11 w-24 rounded-md md:h-9 ${pulse}`} />
          ))}
        </div>
        <div className={`h-32 rounded-md ${pulse}`} />
        {["a", "b", "c", "d", "e", "f"].map((k) => (
          <div key={k} className={`h-10 rounded-sm ${pulse}`} />
        ))}
      </div>
    </>
  );
}
