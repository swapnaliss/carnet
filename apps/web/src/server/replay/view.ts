// Read side of replay mode for pages (M4-05): the recording index from the database (written by
// `npm run demo:reset`), as views. No file system and no network: only the replay_recordings rows.
import { type Db, listReplayRecordings } from "@carnet/db";
import { type RecordingView, recordingView } from "./recording";

export async function loadRecordings(db: Db): Promise<RecordingView[]> {
  const rows = await listReplayRecordings(db);
  return rows.map(recordingView).filter((v): v is RecordingView => v !== null);
}

/** The capture date(s) the banner names, from the active (last materialized) recording's manifest. */
export async function bannerDate(db: Db): Promise<string | null> {
  const rows = await listReplayRecordings(db);
  const active = [...rows].reverse().find((r) => r.materialized) ?? rows.at(-1);
  if (!active) return null;
  const m = (active.manifest ?? {}) as { run_date?: unknown; run_date_end?: unknown };
  const start = typeof m.run_date === "string" ? m.run_date : null;
  const end = typeof m.run_date_end === "string" ? m.run_date_end : null;
  if (!start) return null;
  return end && end !== start ? `${formatDay(start)} – ${formatDay(end)}` : formatDay(start);
}

function formatDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
