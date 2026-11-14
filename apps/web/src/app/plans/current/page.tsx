import type { Metadata } from "next";
import { PlanPage } from "@/components/plan/plan-page";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.plan.title };
export const dynamic = "force-dynamic";

// The newest plan revision (docs/design/screens/plan-screen.md). Server component: the first render is
// fetched here, the client island polls and holds the approval controls.
export default function CurrentPlanPage() {
  return <PlanPage which="current" />;
}
