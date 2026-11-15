import { Film, Radio } from "lucide-react";
import Link from "next/link";
import { getPageMode } from "@/lib/page-session";
import { appDb } from "@/server/db";
import { bannerDate } from "@/server/replay/view";
import { fill, t } from "@/strings";
import { ModeSwitch } from "./mode-switch";

/**
 * M4-05: the persistent, non-dismissible recording banner on every screen of a replay session, or the
 * LIVE indicator that replaces it for a live owner session. Nothing for a signed-out visitor.
 */
export async function ModeBanner() {
  const mode = await getPageMode();
  if (!mode) return null;
  if (mode.mode === "live") {
    if (!mode.canSwitch) return null;
    return (
      <section
        aria-label={t.replay.liveLabel}
        data-testid="mode-live-indicator"
        className="flex flex-wrap items-center gap-3 border-b border-border bg-status-success-bg px-4 py-2 text-sm text-status-success-fg md:px-6"
      >
        <span className="inline-flex items-center gap-1.5 rounded-sm border border-current px-2 py-0.5 text-xs font-semibold tracking-wide">
          <Radio aria-hidden="true" className="size-3.5" />
          {t.replay.live}
        </span>
        <span>{t.replay.liveHint}</span>
        <span className="ms-auto">
          <ModeSwitch to="replay" />
        </span>
      </section>
    );
  }
  const date = await bannerDate(appDb().db).catch(() => null);
  const text = date ? fill(t.replay.banner, { date }) : t.replay.bannerNoRecording;
  return (
    <section
      aria-label={t.replay.bannerLabel}
      data-testid="recording-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-status-warning-bg px-4 py-2 text-sm text-status-warning-fg md:px-6"
    >
      <Film aria-hidden="true" className="size-4 shrink-0" />
      <p className="font-medium">{text}</p>
      <Link
        href="/replay#what-is-real"
        className="underline underline-offset-4 focus-visible:outline-offset-2"
      >
        {t.replay.whatIsReal}
      </Link>
      {mode.canSwitch ? (
        <span className="ms-auto">
          <ModeSwitch to="live" />
        </span>
      ) : null}
    </section>
  );
}
