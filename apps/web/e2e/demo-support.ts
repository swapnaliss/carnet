import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

// Helpers shared by the M3-07 specs: demo-live.spec.ts (live, E2E_MODE=live) and demo-replay.spec.ts
// (CI replay, E2E_MODE=replay). Same shape as the M2-09 live spec's helpers (core-demo.live.spec.ts).

/** An environment value; an empty or blank value counts as unset (a shell `E2E_X=` must not enable a run). */
export function envValue(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Api {
  call<T = Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: T }>;
  poll<T>(
    label: string,
    fn: () => Promise<T | null | undefined | false>,
    timeoutMs: number,
    everyMs?: number,
  ): Promise<T>;
}

/** JSON calls through the signed-in page's cookie jar, and a poll that names the last answer on failure. */
export function apiFor(page: () => Page): Api {
  let lastSeen = "(no API call yet)";
  const call: Api["call"] = async (method, path, body, headers = {}) => {
    const res = await page().request.fetch(path, {
      method,
      headers: { accept: "application/json", ...headers },
      ...(body === undefined ? {} : { data: body }),
      timeout: 30_000,
    });
    const parsed = (await res.json().catch(() => ({}))) as never;
    lastSeen = `${method} ${path} -> ${res.status()} ${JSON.stringify(parsed).slice(0, 600)}`;
    return { status: res.status(), body: parsed };
  };
  const poll: Api["poll"] = async (label, fn, timeoutMs, everyMs = 3_000) => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - start > timeoutMs)
        throw new Error(`timed out after ${timeoutMs} ms: ${label}. Last API answer: ${lastSeen}`);
      await sleep(everyMs);
    }
  };
  return { call, poll };
}

/** Next Friday (UTC, 12:00) strictly after `from`: the storyboard's "by Friday". */
export function nextFriday(from: Date): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 12));
  const ahead = (5 - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + ahead);
  return d;
}

/** The plan screen, as the storyboard's steps 1 and 6 read it. Used by both specs. */
export async function expectPlanScreen(page: Page, revision: number): Promise<void> {
  await page.goto("/plans/current");
  await expect(page.getByTestId("plan-screen")).toBeVisible();
  await expect(page.getByTestId("plan-revision")).toHaveText(`Revision ${revision}`);
  await expect(page.getByTestId("plan-inputs-hash")).toContainText(/Plan fingerprint [0-9a-f]{8}/);
}

/** The payee's public page in a fresh context; returns its headers and visible status text. */
export async function readPayeePage(
  page: Page,
  url: string,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const context = await page.context().browser()?.newContext();
  if (!context) throw new Error("no browser");
  try {
    const payee = await context.newPage();
    const res = await payee.goto(url);
    const text = await payee.locator("body").innerText();
    return { status: res?.status() ?? 0, headers: res?.headers() ?? {}, text };
  } finally {
    await context.close();
  }
}

export function expectPayeeHeaders(headers: Record<string, string>): void {
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-robots-tag"]).toContain("noindex");
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["x-content-type-options"]).toBe("nosniff");
}

export function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}
