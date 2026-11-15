// Replay recordings (M4-05, ADR 0018 amendment 2). A recording is a directory under fixtures/replay/
// with a manifest.json; `npm run demo:reset` reads it, builds an ordered timeline from the recording's
// own files (this module, pure: no I/O) and stores manifest, timeline and screen refs in the
// replay_recordings index. The web reads only that index: nothing here is hard-coded UI, and every
// value shown comes from a recorded file, named in each event's `source`.
//
// Recognised files, by name, wherever the manifest lists them (`files`, relative to the recording
// directory, or `sources` for files kept elsewhere in fixtures/):
//   run.json             the live spec's step log (storyboard steps, with times)          -> storyboard
//   webhooks.jsonl       webhook_events rows (M3-07 capture)                              -> webhook
//   webhooks/ (a dir)    one stored webhook per file (M2-09 fixtures)                     -> webhook
//   model-outputs.jsonl  agent_runs and agent_steps rows (M3-07 capture)                  -> model
//   anthropic/ (a dir)   recorded model responses (M2-09 fixtures)                        -> model
//   attempts.json        execution_attempts, approvals, audit_log (M3-07 capture)         -> attempt, approval
//   respond-attempt.json the respond attempt as stored (M2-09)                            -> attempt
//   plans.json           plans and plan actions (M3-07 capture)                           -> plan
import { z } from "zod";

export const TIMELINE_KINDS = [
  "storyboard",
  "webhook",
  "model",
  "attempt",
  "approval",
  "plan",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const TimelineEventSchema = z.strictObject({
  at: z.string(),
  kind: z.enum(TIMELINE_KINDS),
  title: z.string(),
  detail: z.string(),
  /** A route template; `{name}` is resolved from the recording's refs, else the event has no link. */
  screen: z.string().nullable(),
  /** The recorded file this event was read from, relative to the repository root. */
  source: z.string(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const ManifestSchema = z.looseObject({
  kind: z.literal("recording"),
  label: z.string().optional(),
  ticket: z.string().optional(),
  run: z.string().nullable().optional(),
  run_date: z.string().nullable().optional(),
  deployed_version: z.string().nullable().optional(),
  models: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  /** How the screens are loaded into the replay business; absent: the timeline only. */
  materialize: z.string().optional(),
  /** Storyboard step number -> route template; merged over DEFAULT_STEP_SCREENS. */
  screens: z.record(z.string(), z.string()).optional(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** The storyboard's screens (PROJECT.md demo storyboard): where each step is seen. */
export const DEFAULT_STEP_SCREENS: Record<string, string> = {
  "1": "/queue",
  "2": "/payments/{strong}/evidence",
  "3": "/payments/{strong}/evidence",
  "4": "/queue",
  "5": "/payments/{strong}",
  "6": "/rfis/{rfi}",
  "7": "/rfis/{rfi}",
  "8": "/payments/{strong}",
  "9": "/plans/current",
  "10": "/plans/current",
  "11": "/replay/payee",
  "12": "/ops",
};

/** One file the timeline builder reads, already parsed by the caller. */
export type RecordedFile =
  | { readonly name: "run.json"; readonly path: string; readonly json: unknown }
  | { readonly name: "webhooks.jsonl"; readonly path: string; readonly rows: unknown[] }
  | { readonly name: "webhook"; readonly path: string; readonly json: unknown }
  | { readonly name: "model-outputs.jsonl"; readonly path: string; readonly rows: unknown[] }
  | { readonly name: "anthropic"; readonly path: string; readonly json: unknown }
  | { readonly name: "attempts.json"; readonly path: string; readonly json: unknown }
  | { readonly name: "respond-attempt.json"; readonly path: string; readonly json: unknown }
  | { readonly name: "hold-view.json"; readonly path: string; readonly json: unknown }
  | { readonly name: "plans.json"; readonly path: string; readonly json: unknown };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function usd(nano: unknown): string {
  const n = Number(nano);
  return Number.isFinite(n) ? `USD ${(n / 1e9).toFixed(4)}` : "cost not recorded";
}

function webhookEvent(row: Obj, path: string): TimelineEvent | null {
  const at = str(row.received_at);
  const name = str(row.name);
  if (!at || !name) return null;
  const body = obj(row.body ?? safeJson(row.raw_body));
  const data = obj(body.data);
  const status = str(data.status);
  const object = str(data.id);
  const isRfi = name.startsWith("rfi.");
  return {
    at,
    kind: "webhook",
    title: `Airwallex webhook ${name}`,
    detail: [
      object ? `${isRfi ? "RFI" : "transfer"} ${object}` : null,
      status ? `status ${status}` : null,
      row.acked_at ? `acknowledged ${str(row.acked_at)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    screen: isRfi ? "/rfis/{rfi}" : "/payments/{strong}",
    source: path,
  };
}

function safeJson(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function anthropicEvent(json: Obj, path: string): TimelineEvent | null {
  const at = str(json.recorded_at);
  if (!at) return null;
  const kind = str(json.kind) ?? "model";
  const model = str(json.model) ?? "unknown model";
  const latency = Number(obj(arr(json.calls)[0]).latency_ms);
  const outcome = obj(json.stored_draft_outcome);
  const subject = str(json.file) ?? str(json.set_id) ?? "";
  return {
    at,
    kind: "model",
    title:
      kind === "drafting"
        ? `Model drafted the RFI answers (${model})`
        : `Model read ${subject} (${model})`,
    detail: [
      Number.isFinite(latency) ? `${(latency / 1000).toFixed(1)} s` : null,
      usd(json.stored_cost_nano_usd),
      str(outcome.state) ? `draft ${str(outcome.state)}` : null,
      str(json.prompt_version) ? `prompt ${str(json.prompt_version)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    screen: kind === "drafting" ? "/rfis/{rfi}" : "/payments/{strong}/evidence",
    source: path,
  };
}

function modelOutputEvent(row: Obj, path: string): TimelineEvent | null {
  if (row.kind !== "step") return null;
  const at = str(row.created_at);
  if (!at) return null;
  return {
    at,
    kind: "model",
    title: `Model step ${str(row.step) ?? ""} (${str(row.model) ?? "unknown model"})`,
    detail: [
      str(row.outcome) ? `outcome ${str(row.outcome)}` : null,
      usd(row.cost_nano_usd),
      row.latency_ms !== undefined ? `${row.latency_ms} ms` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    screen: null,
    source: path,
  };
}

function attemptEvent(row: Obj, path: string): TimelineEvent | null {
  const at = str(row.resolved_at) ?? str(row.updated_at) ?? str(row.created_at);
  const kind = str(row.kind);
  if (!at || !kind) return null;
  return {
    at,
    kind: "attempt",
    title: `Execution attempt: ${kind}`,
    detail: [
      str(row.status) ? `status ${str(row.status)}` : null,
      str(row.request_id) ? `request ${str(row.request_id)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    screen: kind === "respond" ? "/rfis/{rfi}" : "/plans/current",
    source: path,
  };
}

function approvalEvent(row: Obj, path: string): TimelineEvent | null {
  const at = str(row.created_at);
  if (!at) return null;
  return {
    at,
    kind: "approval",
    title: `Approval ${str(row.status) ?? ""}`.trim(),
    detail: [str(row.subject_type), str(row.status)].filter(Boolean).join(" · "),
    screen: str(row.subject_type) === "plan_action" ? "/plans/current" : "/rfis/{rfi}",
    source: path,
  };
}

function planEvent(row: Obj, path: string): TimelineEvent | null {
  const at = str(row.created_at);
  if (!at) return null;
  return {
    at,
    kind: "plan",
    title: `Plan revision ${row.revision ?? ""}`.trim(),
    detail: [str(row.status), str(row.trigger) ? `trigger ${str(row.trigger)}` : null]
      .filter(Boolean)
      .join(" · "),
    screen: "/plans/current",
    source: path,
  };
}

function storyboardEvents(
  json: Obj,
  path: string,
  screens: Record<string, string>,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const raw of arr(json.steps)) {
    const step = obj(raw);
    const at = str(step.at);
    const name = str(step.name);
    if (!at || !name) continue;
    const n = String(step.step ?? "");
    const facts = Object.entries(step)
      .filter(
        ([k, v]) => !["step", "name", "at"].includes(k) && (typeof v !== "object" || v === null),
      )
      .map(([k, v]) => `${k.replaceAll("_", " ")}: ${String(v)}`);
    out.push({
      at,
      kind: "storyboard",
      title: name.charAt(0).toUpperCase() + name.slice(1),
      detail: [n ? `Storyboard step ${n}` : null, ...facts].filter(Boolean).join(" · "),
      screen: screens[n] ?? null,
      source: path,
    });
  }
  return out;
}

/** The ordered timeline of one recording (by time, then by kind order for ties). */
export function buildTimeline(manifest: Manifest, files: readonly RecordedFile[]): TimelineEvent[] {
  const screens = { ...DEFAULT_STEP_SCREENS, ...(manifest.screens ?? {}) };
  const events: TimelineEvent[] = [];
  const push = (e: TimelineEvent | null) => {
    if (e) events.push(e);
  };
  for (const f of files) {
    switch (f.name) {
      case "run.json":
        events.push(...storyboardEvents(obj(f.json), f.path, screens));
        break;
      case "webhooks.jsonl":
        for (const r of f.rows) push(webhookEvent(obj(r), f.path));
        break;
      case "webhook":
        push(webhookEvent(obj(f.json), f.path));
        break;
      case "model-outputs.jsonl":
        for (const r of f.rows) push(modelOutputEvent(obj(r), f.path));
        break;
      case "anthropic":
        push(anthropicEvent(obj(f.json), f.path));
        break;
      case "attempts.json": {
        const j = obj(f.json);
        for (const r of arr(j.execution_attempts)) push(attemptEvent(obj(r), f.path));
        for (const r of arr(j.approvals)) push(approvalEvent(obj(r), f.path));
        break;
      }
      case "respond-attempt.json":
        push(attemptEvent(obj(obj(f.json).attempt), f.path));
        break;
      case "hold-view.json": {
        const draft = obj(obj(f.json).draft);
        const at = str(draft.created_at);
        if (at) {
          push({
            at,
            kind: "approval",
            title: `Owner's draft ${str(draft.state) ?? ""}`.trim(),
            detail: `origin ${str(draft.origin) ?? "unknown"} · ready for one approval`,
            screen: "/rfis/{rfi}",
            source: f.path,
          });
        }
        break;
      }
      case "plans.json":
        for (const r of arr(obj(f.json).plans)) push(planEvent(obj(r), f.path));
        break;
    }
  }
  const order = (k: TimelineKind) => TIMELINE_KINDS.indexOf(k);
  return events.sort(
    (a, b) =>
      Date.parse(a.at) - Date.parse(b.at) ||
      order(a.kind) - order(b.kind) ||
      a.title.localeCompare(b.title),
  );
}

/** Resolves `{name}` from refs; a route with an unknown ref has no link (null). */
export function resolveScreen(
  template: string | null,
  refs: Record<string, string>,
): string | null {
  if (!template) return null;
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = refs[key];
    if (!v) missing = true;
    return encodeURIComponent(v ?? "");
  });
  return missing ? null : out;
}

/** The view a page renders: one recording's metadata and its resolved timeline. */
export interface RecordingView {
  readonly id: string;
  readonly label: string;
  readonly capturedOn: string | null;
  readonly deployedVersion: string | null;
  readonly models: readonly string[];
  readonly materialized: boolean;
  readonly events: readonly (TimelineEvent & { readonly href: string | null })[];
}

export function recordingView(row: {
  id: string;
  manifest: unknown;
  timeline: unknown;
  refs: Record<string, string>;
  materialized: boolean;
}): RecordingView | null {
  const manifest = ManifestSchema.safeParse(row.manifest);
  const timeline = z.array(TimelineEventSchema).safeParse(row.timeline);
  if (!manifest.success || !timeline.success) return null;
  return {
    id: row.id,
    label: manifest.data.label ?? row.id,
    capturedOn: manifest.data.run_date ?? null,
    deployedVersion: manifest.data.deployed_version ?? null,
    models: manifest.data.models ?? [],
    materialized: row.materialized,
    events: timeline.data.map((e) => ({
      ...e,
      href: row.materialized ? resolveScreen(e.screen, row.refs) : null,
    })),
  };
}
