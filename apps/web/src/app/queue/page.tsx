import { ListChecks } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState, PageTitle } from "@/components/shell/empty-state";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.queue.title };

// Placeholder until M2-03 builds the queue to docs/design/screens/payment-queue.md.
export default function QueuePage() {
  return (
    <>
      <PageTitle>{t.queue.title}</PageTitle>
      <EmptyState icon={ListChecks} title={t.queue.empty.title} body={t.queue.empty.body} />
    </>
  );
}
