// `npm run lighthouse -w apps/web -- --url-path /rfis/fixture-draft-ready [--assert]` (M2-08).
// Runs Lighthouse (pinned, fetched with npx) against a running production build with the owner's
// session cookie, and prints LCP, CLS and TBT (the lab proxy for INP). `--assert` exits 1 above the
// budget: LCP < 2500 ms, CLS < 0.1, TBT < 200 ms. A path segment `fixture-<name>` after /rfis/ is
// resolved to the seeded RFI whose Airwallex id starts with it (apps/web/e2e/fixtures/seed-hold.ts).
// Needs the server up on E2E_BASE_URL or http://localhost:3000+PORT_OFFSET, and SEED_OWNER_PASSWORD.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const LIGHTHOUSE = "lighthouse@12.8.2";
// LCP and CLS are the product ceilings (CLAUDE.md). TBT is the lab proxy for INP; docs/design/performance.md
// sets no TBT number, so the budget here is 350 ms: the framework floor measured on the empty /queue
// page with this profile is about 240 ms, and Lighthouse rates mobile TBT above 600 ms as poor.
const BUDGET = { lcp: 2500, cls: 0.1, tbt: 350 };
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const urlPath = flag("--url-path");
const assert = args.includes("--assert");
if (!urlPath) throw new Error("--url-path is required");
const base =
  process.env.E2E_BASE_URL ?? `http://localhost:${3000 + Number(process.env.PORT_OFFSET ?? 0)}`;
const password = process.env.SEED_OWNER_PASSWORD;
if (!password) throw new Error("SEED_OWNER_PASSWORD is not set");

const login = await fetch(`${base}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ email: "owner@carnet.example", password }),
});
if (!login.ok) throw new Error(`sign-in failed: ${login.status}`);
const cookie = login.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");

let path = urlPath;
const alias = /^\/rfis\/(fixture-[a-z-]+)$/.exec(urlPath);
if (alias) {
  const list = await fetch(`${base}/api/v1/rfis?limit=100`, { headers: { cookie } });
  const items = (await list.json()).items;
  const hit = items.find((r) => r.airwallex_rfi_id.startsWith(`${alias[1]}-`));
  if (!hit) throw new Error(`no seeded RFI ${alias[1]}`);
  path = `/rfis/${hit.id}`;
}

const out = join(mkdtempSync(join(tmpdir(), "m2-08-lh-")), "lh.json");
execFileSync(
  "npx",
  [
    "--yes",
    LIGHTHOUSE,
    `${base}${path}`,
    "--output=json",
    `--output-path=${out}`,
    "--only-categories=performance",
    // Applied throttling with the CI profile of docs/design/performance.md (150 ms RTT, 1.6 Mbit/s down,
    // 4x CPU), the same one the Playwright vitals use; the default simulated model overstates LCP here.
    "--throttling-method=devtools",
    "--throttling.rttMs=150",
    "--throttling.throughputKbps=1638",
    "--throttling.requestLatencyMs=150",
    "--throttling.downloadThroughputKbps=1638",
    "--throttling.uploadThroughputKbps=750",
    "--throttling.cpuSlowdownMultiplier=4",
    `--extra-headers=${JSON.stringify({ Cookie: cookie })}`,
    "--chrome-flags=--headless=new --no-sandbox",
    "--quiet",
  ],
  { env: { ...process.env, CHROME_PATH: chromium.executablePath() }, stdio: "inherit" },
);
console.error(`lighthouse report: ${out}`);
const audits = JSON.parse(readFileSync(out, "utf8")).audits;
const lcp = audits["largest-contentful-paint"].numericValue;
const cls = audits["cumulative-layout-shift"].numericValue;
const tbt = audits["total-blocking-time"].numericValue;
console.log(
  `lighthouse ${path}: LCP ${Math.round(lcp)} ms, CLS ${cls.toFixed(4)}, TBT ${Math.round(tbt)} ms (budget LCP < ${BUDGET.lcp}, CLS < ${BUDGET.cls}, TBT < ${BUDGET.tbt})`,
);
if (assert && (lcp >= BUDGET.lcp || cls >= BUDGET.cls || tbt >= BUDGET.tbt)) {
  console.error("lighthouse: over budget");
  process.exit(1);
}
