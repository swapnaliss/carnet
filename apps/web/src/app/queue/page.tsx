import type { Metadata } from "next";
import { Suspense } from "react";
import { QueueView } from "@/components/queue/queue-view";
import { PageTitle } from "@/components/shell/empty-state";
import { repo } from "@/lib/authz";
import { requirePageSession } from "@/lib/page-session";
import { loadQueue } from "@/server/queue";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.queue.title };
export const dynamic = "force-dynamic";

// The payment queue (M2-03), built to docs/design/screens/payment-queue.md.
export default async function QueuePage() {
  const ctx = await requirePageSession();
  const initial = await loadQueue(repo(ctx));
  return (
    <>
      <PageTitle>{t.queue.title}</PageTitle>
      <p className="mb-6 max-w-[65ch] text-muted-foreground">{t.queue.intro}</p>
      <Suspense fallback={null}>
        <QueueView initial={initial} canCreate={ctx.role === "owner"} />
      </Suspense>
    </>
  );
}
