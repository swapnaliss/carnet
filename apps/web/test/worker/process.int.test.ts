// Worker mode as a real process (AC 11, BL-01 6575762493): the esbuild bundle starts with plain
// `node`, imports the workspace packages, and SIGTERM lets the in-flight job finish before exit 0.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enqueueJob, getJob } from "@carnet/db";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, webTestDatabase } from "../support";

const db = webTestDatabase();
const webRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "carnet-worker-test-"));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

interface Run {
  child: ChildProcess;
  lines: Record<string, unknown>[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitFor: (pred: (l: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<void>;
}

function start(file: string, env: Record<string, string>): Run {
  const child = spawn(process.execPath, [file], {
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", LOG_LEVEL: "info", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: Record<string, unknown>[] = [];
  const onData = (chunk: Buffer) => {
    for (const raw of chunk.toString("utf8").split("\n")) {
      if (!raw.trim()) continue;
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        lines.push({ raw });
      }
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
    child.on("exit", (code, signal) => res({ code, signal })),
  );
  const waitFor = async (pred: (l: Record<string, unknown>) => boolean, timeoutMs = 20_000) => {
    const started = Date.now();
    while (!lines.some(pred)) {
      if (Date.now() - started > timeoutMs) {
        child.kill("SIGKILL");
        throw new Error(`timed out; output so far:\n${JSON.stringify(lines, null, 1)}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { child, lines, exited, waitFor };
}

describe("AC11: SIGTERM", () => {
  it("finishes the in-flight job, then exits 0", async () => {
    const out = join(dir, "slow-worker.mjs");
    await build({
      absWorkingDir: webRoot,
      entryPoints: [join(webRoot, "test/worker/fixtures/slow-worker.ts")],
      outfile: out,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      external: ["pg-native"],
      banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
      logLevel: "silent",
    });
    const run = start(out, { TEST_APP_URL: db().appUrl, TEST_HOLD_MS: "1500" });
    await run.waitFor((l) => l.msg === "worker started");
    const jobId = await enqueueJob(db().app.db, { kind: "test.slow", payload: { n: 1 } });
    await run.waitFor((l) => l.marker === "job-started");

    run.child.kill("SIGTERM");
    const { code, signal } = await run.exited;

    expect(signal).toBeNull();
    expect(code).toBe(0);
    const order = run.lines.map((l) => String(l.marker ?? l.msg));
    const at = (s: string) => order.indexOf(s);
    expect(at("shutdown requested; finishing the in-flight job")).toBeGreaterThan(
      at("job-started"),
    );
    expect(at("job-finished")).toBeGreaterThan(
      at("shutdown requested; finishing the in-flight job"),
    );
    expect(at("worker exited")).toBeGreaterThan(at("job-finished"));
    const job = await getJob(db().app.db, jobId);
    expect(job?.status).toBe("DONE");
    expect(job?.attempts).toBe(1);
  });
});

describe("the production worker bundle (npm run build:worker)", () => {
  it("runs with plain node, claims the reconcile job and stops cleanly on SIGTERM", async () => {
    const out = join(dir, "worker.mjs");
    const built = spawn(process.execPath, [join(webRoot, "scripts/build-worker.mjs"), out], {
      stdio: "ignore",
    });
    expect(await new Promise((r) => built.on("exit", r))).toBe(0);
    await query(db().appUrl, "DELETE FROM outbox_jobs");

    const run = start(out, {
      PROCESS_MODE: "worker",
      DATABASE_URL: db().appUrl,
      WORKER_POLL_MS: "50",
      // Synthetic values. The base URL names a sandbox host on loopback with a closed port, so the
      // reconcile poll fails fast and nothing leaves the machine.
      AIRWALLEX_CLIENT_ID: "test-client-id",
      AIRWALLEX_API_KEY: "test-api-key",
      AIRWALLEX_BASE_URL: "http://sandbox.localhost:9",
      AIRWALLEX_FILES_URL: "http://sandbox.localhost:9",
    });
    await run.waitFor((l) => l.msg === "worker started");
    await run.waitFor((l) => l.msg === "reconcile pass done");
    expect(run.lines.some((l) => l.heartbeat === true)).toBe(true);

    run.child.kill("SIGTERM");
    const { code } = await run.exited;
    expect(code).toBe(0);
    const jobs = await query<{ kind: string; status: string }>(
      db().appUrl,
      "SELECT kind, status FROM outbox_jobs",
    );
    expect(jobs).toEqual([{ kind: "reconcile", status: "DONE" }]);
    // Nothing secret-shaped in the output.
    expect(JSON.stringify(run.lines)).not.toContain("test-api-key");
  });

  it("exits 1 naming the missing key when DATABASE_URL is not set", async () => {
    const out = join(dir, "worker.mjs");
    const run = start(out, { PROCESS_MODE: "worker" });
    const { code } = await run.exited;
    expect(code).toBe(1);
    expect(run.lines.some((l) => l.error === "DATABASE_URL is not set")).toBe(true);
  });
});
