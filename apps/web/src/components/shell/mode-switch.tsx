"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/strings";

/** M4-05: the owner's switch between the recording and live. The server keeps the mode on the session. */
export function ModeSwitch({ to }: { to: "live" | "replay" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function change() {
    setPending(true);
    setFailed(false);
    try {
      const res = await fetch("/api/v1/session/mode", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: to }),
      });
      if (res.ok) {
        router.refresh();
        setPending(false);
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    }
    setPending(false);
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={change}
        disabled={pending}
        aria-busy={pending}
        data-testid={`switch-mode-${to}`}
      >
        {to === "live" ? t.replay.switchToLive : t.replay.switchToReplay}
      </Button>
      {failed ? (
        <span role="alert" className="text-xs">
          {t.replay.switchFailed}
        </span>
      ) : null}
    </span>
  );
}
