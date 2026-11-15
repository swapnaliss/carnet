import { Film } from "lucide-react";
import type { Metadata } from "next";
import { ReplayTimeline } from "@/components/replay/replay-timeline";
import { EmptyState, PageTitle } from "@/components/shell/empty-state";
import { requirePageSession } from "@/lib/page-session";
import { appDb } from "@/server/db";
import { loadRecordings } from "@/server/replay/view";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.replay.page.title };
export const dynamic = "force-dynamic";

// The recorded run's timeline (M4-05, docs/design/screens/replay.md). Server-authorised: a session is
// required; the data is the replay_recordings index the demo reset wrote, nothing else.
export default async function ReplayPage() {
  const ctx = await requirePageSession();
  const all = await loadRecordings(appDb().db);
  // Links open screens of the business this session reads; other recordings show their timeline only.
  const recordings = all.map((r) => (ctx.mode === "replay" ? r : { ...r, materialized: false }));
  return (
    <>
      <PageTitle>{t.replay.page.title}</PageTitle>
      <p className="mb-6 max-w-[65ch] text-muted-foreground">{t.replay.page.intro}</p>
      {recordings.length === 0 ? (
        <EmptyState icon={Film} title={t.replay.page.emptyTitle} body={t.replay.page.emptyBody} />
      ) : (
        <div className="flex flex-col gap-10">
          {recordings.map((r) => (
            <ReplayTimeline key={r.id} recording={r} />
          ))}
        </div>
      )}
      <section
        id="what-is-real"
        aria-labelledby="what-is-real-title"
        className="mt-10 max-w-[65ch] rounded-md border border-border bg-card p-6"
      >
        <h2 id="what-is-real-title" className="mb-2 text-lg font-semibold">
          {t.replay.page.realTitle}
        </h2>
        <p className="text-muted-foreground">{t.replay.page.realBody}</p>
      </section>
    </>
  );
}
