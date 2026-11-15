// Reads the recordings under fixtures/replay/<id>/manifest.json (M4-05) and builds each one's timeline
// with the pure builder in apps/web/src/server/replay/recording.ts. Offline: it reads files only.
// A recording is a drop-in: a new directory with a manifest (scripts/demo-capture-m3.ts writes one)
// is picked up by the next `npm run demo:reset` without a code change.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTimeline,
  type Manifest,
  ManifestSchema,
  type RecordedFile,
  type TimelineEvent,
} from "../../apps/web/src/server/replay/recording";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const REPLAY_DIR = join(ROOT, "fixtures/replay");

export interface LoadedRecording {
  readonly id: string;
  readonly dir: string;
  readonly manifest: Manifest;
  readonly timeline: TimelineEvent[];
  /** sha256 over the manifest and every file the timeline was read from (the generation key). */
  readonly fingerprint: string;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;
const readJsonl = (path: string): unknown[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);

/** Expands one manifest entry (a file or a directory) into the files the builder knows. */
function recordedFiles(abs: string): RecordedFile[] {
  if (!existsSync(abs)) throw new Error(`recording file missing: ${relative(ROOT, abs)}`);
  const path = relative(ROOT, abs);
  if (statSync(abs).isDirectory()) {
    const kind = /webhooks/.test(path) ? "webhook" : /anthropic/.test(path) ? "anthropic" : null;
    if (!kind) return [];
    return readdirSync(abs)
      .filter((n) => n.endsWith(".json"))
      .sort()
      .map((n) => ({ name: kind, path: `${path}/${n}`, json: readJson(join(abs, n)) }));
  }
  const name = basename(abs);
  switch (name) {
    case "webhooks.jsonl":
    case "model-outputs.jsonl":
      return [{ name, path, rows: readJsonl(abs) }];
    case "run.json":
    case "attempts.json":
    case "respond-attempt.json":
    case "plans.json":
      return [{ name, path, json: readJson(abs) }];
    case "hold-view-final.json":
      return [{ name: "hold-view.json", path, json: readJson(abs) }];
    default:
      return [];
  }
}

function filesOf(dir: string, manifest: Manifest): string[] {
  return [
    ...(manifest.files ?? []).map((f) => join(dir, f)),
    ...(manifest.sources ?? []).map((f) => join(ROOT, f)),
  ];
}

function hashPaths(manifestText: string, paths: readonly string[]): string {
  const h = createHash("sha256").update(manifestText);
  const visit = (p: string) => {
    if (statSync(p).isDirectory()) {
      for (const n of readdirSync(p).sort()) visit(join(p, n));
    } else {
      h.update(relative(ROOT, p)).update(readFileSync(p));
    }
  };
  for (const p of paths) visit(p);
  return h.digest("hex");
}

export function loadRecordings(dir = REPLAY_DIR): LoadedRecording[] {
  if (!existsSync(dir)) return [];
  const out: LoadedRecording[] = [];
  for (const id of readdirSync(dir).sort()) {
    const manifestPath = join(dir, id, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const text = readFileSync(manifestPath, "utf8");
    const manifest = ManifestSchema.parse(JSON.parse(text));
    const paths = filesOf(join(dir, id), manifest);
    const files = paths.flatMap(recordedFiles);
    out.push({
      id,
      dir: join(dir, id),
      manifest,
      timeline: buildTimeline(manifest, files),
      fingerprint: hashPaths(text, paths),
    });
  }
  return out;
}
