import { Activity } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState, PageTitle } from "@/components/shell/empty-state";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.ops.title };

// Placeholder until M1-09 and M4 build ops to docs/design/screens/ops.md.
export default function OpsPage() {
  return (
    <>
      <PageTitle>{t.ops.title}</PageTitle>
      <EmptyState icon={Activity} title={t.ops.empty.title} body={t.ops.empty.body} />
    </>
  );
}
