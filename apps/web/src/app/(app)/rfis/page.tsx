import type { Metadata } from "next";
import { RfiList } from "@/components/rfi/rfi-list";
import { PageTitle } from "@/components/shell/empty-state";
import { requirePageSession } from "@/lib/page-session";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.rfis.title };
export const dynamic = "force-dynamic";

export default async function RfisPage() {
  const ctx = await requirePageSession();
  return (
    <>
      <PageTitle>{t.rfis.title}</PageTitle>
      <p className="mb-6 max-w-[65ch] text-muted-foreground">{t.rfis.intro}</p>
      <RfiList canLink={ctx.role !== "viewer"} />
    </>
  );
}
