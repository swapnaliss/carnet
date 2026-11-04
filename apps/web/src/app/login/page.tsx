import { LogIn, UserCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "@/components/auth/login-form";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { EmptyState } from "@/components/shell/empty-state";
import { Button } from "@/components/ui/button";
import { logger } from "@/lib/logger";
import { getPageSession } from "@/lib/page-session";
import { t } from "@/strings";

export const metadata: Metadata = { title: t.auth.login.title };
export const dynamic = "force-dynamic";

// Sign-in form, or the signed-in user with sign-out (M1-04). Styling to the design system is M1-08's.
async function currentSession() {
  try {
    return await getPageSession();
  } catch (error) {
    // Auth not configured (no DATABASE_URL / BETTER_AUTH_*): show the form; sign-in answers 500.
    logger().error(
      {
        event: "auth.page_session_failed",
        err: error instanceof Error ? error.message : "unknown",
      },
      "could not read the session",
    );
    return null;
  }
}

export default async function LoginPage() {
  const session = await currentSession();

  if (session) {
    return (
      <div className="max-w-md">
        <EmptyState
          headingLevel={1}
          icon={UserCheck}
          title={t.auth.session.title}
          body={`${t.auth.session.roleLabel}: ${t.auth.role[session.role]}`}
          action={
            <div className="flex flex-col items-start gap-3">
              {session.role === "viewer" ? (
                <p className="text-sm text-muted-foreground">{t.auth.session.readOnly}</p>
              ) : null}
              <SignOutButton />
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="max-w-md">
      <EmptyState
        headingLevel={1}
        icon={LogIn}
        title={t.auth.login.title}
        body={t.auth.login.body}
        action={
          <div className="flex w-full flex-col gap-4">
            <LoginForm />
            <Button asChild variant="link" className="self-start px-0">
              <Link href="/">{t.auth.login.back}</Link>
            </Button>
          </div>
        }
      />
    </div>
  );
}
