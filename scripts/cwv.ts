// Core Web Vitals for Carnet's key routes (M4-07 Scope 5): LCP, CLS and INP, measured with Playwright
// and PerformanceObserver (no extra service), on a production build. Two profiles, cold and warm, N runs
// each; the median and the worst run are reported against the budgets (LCP < 2.5 s, INP < 200 ms,
// CLS < 0.1, judged on the median).
//
//   npx tsx scripts/cwv.ts --url <origin> [--runs 5] [--out cwv.json] [--assert]
//
// Profiles (docs/design/performance.md): "mobile" = 375x812 touch, CPU slowed 4x, 150 ms RTT, 1.6 Mbit/s
// down, 750 kbit/s up (a mid-tier phone on slow 4G); "desktop" = 1440x900, no CPU slowdown, 40 ms RTT,
// 10 Mbit/s. "cold" = a fresh context with the HTTP cache disabled; "warm" = the same route loaded a
// second time in one context with the cache on.
//
// INP is measured from Event Timing entries (durationThreshold 16 ms) during scripted interactions on
// the hold screen: expand a citation's full quote, open the approve dialog, close it with Escape. With
// this few interactions INP is the longest one. Signs in as the owner with E2E_OWNER_EMAIL (default
// owner@carnet.example) and E2E_OWNER_PASSWORD or SEED_OWNER_PASSWORD; prints no secret.
import { writeFileSync } from "node:fs";
import { type BrowserContext, chromium, type Page } from "@playwright/test";

interface Args {
  url: string;
  runs: number;
  out: string | null;
  assert: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = get("--url");
  if (!url) throw new Error("--url <origin> is required");
  const runs = Number(get("--runs") ?? 5);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  return {
    url: url.replace(/\/$/, ""),
    runs,
    out: get("--out") ?? null,
    assert: argv.includes("--assert"),
  };
}

export const BUDGET = { lcpMs: 2_500, inpMs: 200, cls: 0.1 } as const;

const PROFILES = {
  mobile: {
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    cpu: 4,
    net: { latency: 150, down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8 },
  },
  desktop: {
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
    cpu: 1,
    net: { latency: 40, down: (10 * 1024 * 1024) / 8, up: (5 * 1024 * 1024) / 8 },
  },
} as const;
type Profile = keyof typeof PROFILES;

interface Sample {
  route: string;
  profile: Profile;
  cache: "cold" | "warm";
  run: number;
  lcpMs: number;
  cls: number;
  inpMs: number | null;
}

const OBSERVERS = () => {
  const w = window as unknown as { __lcp: number; __cls: number; __inp: number };
  w.__lcp = 0;
  w.__cls = 0;
  w.__inp = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__lcp = e.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as Array<
      PerformanceEntry & { value: number; hadRecentInput: boolean }
    >)
      if (!e.hadRecentInput) w.__cls += e.value;
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as Array<PerformanceEntry & { interactionId?: number }>)
      if (e.interactionId) w.__inp = Math.max(w.__inp, e.duration);
  }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
};

async function newContext(
  browser: import("@playwright/test").Browser,
  base: string,
  profile: Profile,
  cache: "cold" | "warm",
): Promise<{ context: BrowserContext; page: Page }> {
  const p = PROFILES[profile];
  const context = await browser.newContext({
    baseURL: base,
    viewport: p.viewport,
    isMobile: p.isMobile,
    hasTouch: p.hasTouch,
  });
  await signIn(context);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: cache === "cold" });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: p.net.latency,
    downloadThroughput: p.net.down,
    uploadThroughput: p.net.up,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: p.cpu });
  await page.addInitScript(OBSERVERS);
  return { context, page };
}

async function signIn(context: BrowserContext): Promise<void> {
  const email = process.env.E2E_OWNER_EMAIL ?? "owner@carnet.example";
  const password = process.env.E2E_OWNER_PASSWORD ?? process.env.SEED_OWNER_PASSWORD;
  if (!password)
    throw new Error("E2E_OWNER_PASSWORD or SEED_OWNER_PASSWORD is required to sign in");
  const res = await context.request.post("/api/auth/sign-in/email", { data: { email, password } });
  if (res.status() !== 200) throw new Error(`sign-in failed: HTTP ${res.status()}`);
}

async function read(page: Page) {
  await page.waitForTimeout(1_500); // late paints and shifts land before reading
  return page.evaluate(() => {
    const w = window as unknown as { __lcp: number; __cls: number; __inp: number };
    return { lcp: w.__lcp, cls: w.__cls, inp: w.__inp };
  });
}

/** The hold screen's scripted interactions for INP: expand a citation, open and close the approve dialog. */
async function interact(page: Page): Promise<void> {
  const quote = page.getByRole("button", { name: "Show full quote" }).first();
  if (await quote.count()) {
    await quote.click();
    await page.waitForTimeout(300);
  }
  const approve = page.getByTestId("approve-button");
  if ((await approve.count()) && (await approve.getAttribute("aria-disabled")) !== "true") {
    await approve.click();
    await page.getByTestId("approve-dialog").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
}

/** Resolves the dynamic routes from the signed-in API: the first open RFI and its payment. */
async function resolveRoutes(browser: import("@playwright/test").Browser, base: string) {
  const context = await browser.newContext({ baseURL: base });
  await signIn(context);
  const res = await context.request.get("/api/v1/rfis?limit=50");
  const body = (await res.json()) as {
    items?: {
      id: string;
      state: string;
      payment_id?: string | null;
      payment?: { id: string } | null;
    }[];
  };
  await context.close();
  const items = body.items ?? [];
  const rfi = items.find((i) => i.state === "DRAFT_READY") ?? items[0];
  if (!rfi) throw new Error("no RFI to open: seed the database first");
  const paymentId = rfi.payment_id ?? rfi.payment?.id ?? null;
  const routes: { name: string; path: string; interact: boolean }[] = [
    { name: "/queue", path: "/queue", interact: false },
    { name: "/rfis/[id] (hold screen)", path: `/rfis/${rfi.id}`, interact: true },
    { name: "/plans/current", path: "/plans/current", interact: false },
  ];
  if (paymentId)
    routes.push({
      name: "/payments/[id]/evidence",
      path: `/payments/${paymentId}/evidence`,
      interact: false,
    });
  return routes;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch();
  const samples: Sample[] = [];
  try {
    const routes = await resolveRoutes(browser, args.url);
    for (const route of routes) {
      for (const profile of Object.keys(PROFILES) as Profile[]) {
        for (const cache of ["cold", "warm"] as const) {
          for (let run = 1; run <= args.runs; run++) {
            const { context, page } = await newContext(browser, args.url, profile, cache);
            if (cache === "warm") {
              await page.goto(route.path, { waitUntil: "load" });
              await page.waitForTimeout(500);
            }
            await page.goto(route.path, { waitUntil: "load" });
            if (route.interact) {
              await page.getByTestId("hold-screen").waitFor({ state: "visible" });
              await interact(page);
            }
            const m = await read(page);
            await context.close();
            samples.push({
              route: route.name,
              profile,
              cache,
              run,
              lcpMs: Math.round(m.lcp),
              cls: Number(m.cls.toFixed(4)),
              inpMs: route.interact ? Math.round(m.inp) : null,
            });
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    const k = `${s.route} | ${s.profile} | ${s.cache}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const summary = [...groups.entries()].map(([key, ss]) => {
    const lcp = ss.map((s) => s.lcpMs);
    const cls = ss.map((s) => s.cls);
    const inp = ss.flatMap((s) => (s.inpMs === null ? [] : [s.inpMs]));
    const row = {
      key,
      lcpMedianMs: median(lcp),
      lcpWorstMs: Math.max(...lcp),
      clsMedian: Number(median(cls).toFixed(4)),
      clsWorst: Math.max(...cls),
      inpMedianMs: inp.length ? median(inp) : null,
      inpWorstMs: inp.length ? Math.max(...inp) : null,
    };
    const pass =
      row.lcpMedianMs > 0 &&
      row.lcpMedianMs < BUDGET.lcpMs &&
      row.clsMedian < BUDGET.cls &&
      (row.inpMedianMs === null || row.inpMedianMs < BUDGET.inpMs);
    return { ...row, pass };
  });

  for (const r of summary) {
    console.log(
      `${r.pass ? "ok  " : "FAIL"} ${r.key}: LCP ${r.lcpMedianMs} ms (worst ${r.lcpWorstMs}); CLS ${r.clsMedian} (worst ${r.clsWorst})${
        r.inpMedianMs === null ? "" : `; INP ${r.inpMedianMs} ms (worst ${r.inpWorstMs})`
      }`,
    );
  }
  const report = {
    measured_at: new Date().toISOString(),
    url_class: /localhost|127\.0\.0\.1/.test(args.url) ? "local" : "hosted",
    runs: args.runs,
    budget: BUDGET,
    profiles: PROFILES,
    summary,
    samples,
  };
  if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  const failed = summary.filter((r) => !r.pass).length;
  console.log(
    `\n${summary.length - failed}/${summary.length} route/profile/cache groups within budget`,
  );
  return args.assert && failed > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`cwv: ${(error as Error).message}`);
    process.exitCode = 2;
  },
);
