import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlanPage } from "@/components/plan/plan-page";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.plan.title };
export const dynamic = "force-dynamic";

// One stored revision, for the before/after of an earlier plan. A revision that does not exist, or
// belongs to another business, is a 404.
export default async function RevisionPlanPage({
  params,
}: {
  params: Promise<{ revision: string }>;
}) {
  const revision = Number((await params).revision);
  if (!Number.isInteger(revision) || revision < 1 || revision > 1_000_000) notFound();
  return <PlanPage which={revision} />;
}
