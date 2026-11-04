import { FileQuestion } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/shell/empty-state";
import { Button } from "@/components/ui/button";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.common.notFound.title };

export default function NotFound() {
  return (
    <EmptyState
      headingLevel={1}
      icon={FileQuestion}
      title={t.common.notFound.title}
      body={t.common.notFound.body}
      action={
        <Button asChild variant="outline">
          <Link href="/">{t.common.action.home}</Link>
        </Button>
      }
    />
  );
}
