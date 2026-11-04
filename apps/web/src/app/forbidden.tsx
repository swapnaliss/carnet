import { ShieldX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/shell/empty-state";
import { Button } from "@/components/ui/button";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.common.forbidden.title };

// Rendered with HTTP 403 when a page calls `forbidden()` (a viewer on /ops, M1-09).
export default function Forbidden() {
  return (
    <EmptyState
      headingLevel={1}
      icon={ShieldX}
      title={t.common.forbidden.title}
      body={t.common.forbidden.body}
      action={
        <Button asChild variant="outline">
          <Link href="/">{t.common.action.home}</Link>
        </Button>
      }
    />
  );
}
