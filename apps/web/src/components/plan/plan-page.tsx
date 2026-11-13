import { notFound } from "next/navigation";
import { PageTitle } from "@/components/shell/empty-state";
import { repo } from "@/lib/authz";
import { requirePageSession } from "@/lib/page-session";
import { loadPlanView } from "@/server/plans";
import { t } from "@/strings";
import { PlanScreen } from "./plan-screen";

/** Server component shared by /plans/current and /plans/{revision}: session, tenant scope, first render. */
export async function PlanPage({ which }: { which: "current" | number }) {
  const ctx = await requirePageSession();
  const view = await loadPlanView(repo(ctx), ctx, which);
  if (!view) notFound();
  return (
    <>
      <PageTitle>{t.plan.title}</PageTitle>
      <PlanScreen initial={view} />
    </>
  );
}
