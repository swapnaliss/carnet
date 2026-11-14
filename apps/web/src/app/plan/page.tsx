import { CalendarRange } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EmptyState, PageTitle } from "@/components/shell/empty-state";
import { getPageSession } from "@/lib/page-session";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.plan.title };
export const dynamic = "force-dynamic";

// The plan lives at /plans/current (M3-04). A signed-in person who opens the old path or the nav link is
// sent there; anyone else sees the empty state, as before (the shell checks this page without a session).
export default async function PlanRedirect() {
  if (await getPageSession()) redirect("/plans/current");
  return (
    <>
      <PageTitle>{t.plan.title}</PageTitle>
      <EmptyState icon={CalendarRange} title={t.plan.empty.title} body={t.plan.empty.body} />
    </>
  );
}
