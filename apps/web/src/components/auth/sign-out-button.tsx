"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/strings";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    try {
      const res = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    }
    setPending(false);
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant="outline"
        onClick={signOut}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? t.auth.session.signOutPending : t.auth.session.signOut}
      </Button>
      <p role="alert" className="text-sm text-destructive">
        {failed ? t.auth.session.signOutError : null}
      </p>
    </div>
  );
}
