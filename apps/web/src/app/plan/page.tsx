import { CalendarRange } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState, PageTitle } from "@/components/shell/empty-state";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.plan.title };

// Placeholder until M3-04 builds the plan to docs/design/screens/plan-screen.md.
export default function PlanPage() {
  return (
    <>
      <PageTitle>{t.plan.title}</PageTitle>
      <EmptyState icon={CalendarRange} title={t.plan.empty.title} body={t.plan.empty.body} />
    </>
  );
}
