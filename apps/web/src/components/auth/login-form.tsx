"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/strings";

// Minimal email-and-password form (M1-04). Posts to /api/auth/sign-in/email; the session arrives as
// an HttpOnly cookie. Styling to the design system is M1-08's.
const fieldClass =
  "min-h-11 w-full rounded-md border border-border bg-background px-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-10";

export function LoginForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      if (res.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      setError(
        res.status === 401
          ? t.auth.login.errorInvalid
          : res.status === 429
            ? t.auth.login.errorRateLimited
            : t.auth.login.errorGeneric,
      );
    } catch {
      setError(t.auth.login.errorGeneric);
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="login-email" className="text-sm font-medium">
          {t.auth.login.email}
        </label>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="username"
          required
          className={fieldClass}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="login-password" className="text-sm font-medium">
          {t.auth.login.password}
        </label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={fieldClass}
        />
      </div>
      <p role="alert" className="min-h-5 text-sm text-destructive">
        {error}
      </p>
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? t.auth.login.submitPending : t.auth.login.submit}
      </Button>
    </form>
  );
}
