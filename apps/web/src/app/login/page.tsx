import { LogIn } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/shell/empty-state";
import { Button } from "@/components/ui/button";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.auth.login.title };

// Token-styled placeholder; M1-04 replaces the body with the better-auth sign-in form.
export default function LoginPage() {
  return (
    <div className="max-w-md">
      <EmptyState
        headingLevel={1}
        icon={LogIn}
        title={t.auth.login.title}
        body={t.auth.login.body}
        action={
          <Button asChild variant="outline">
            <Link href="/">{t.auth.login.back}</Link>
          </Button>
        }
      />
    </div>
  );
}
