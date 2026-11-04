import { type Browser, expect, test } from "@playwright/test";

// Core Web Vitals on the shell home against the production build (`next start`), with the CI profile
// from docs/design/performance.md: CPU slowed 4x, network 150 ms RTT / 1.6 Mbit/s down / 750 kbit/s
// up, cache disabled, 5 runs per viewport. The gate uses the worst run against the shell-home budget
// (LCP < 1.8 s, CLS < 0.05, inside the product ceiling of 2.5 s and 0.1); the median is recorded.
const RUNS = 5;
const BUDGET = { lcpMs: 1_800, cls: 0.05 };

const viewports = [
  { name: "mobile 375", viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
  {
    name: "desktop 1440",
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
  },
] as const;

async function measure(browser: Browser, vp: (typeof viewports)[number]) {
  const context = await browser.newContext({
    viewport: vp.viewport,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  await page.addInitScript(() => {
    const w = window as unknown as { __lcp: number; __cls: number };
    w.__lcp = 0;
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__lcp = entry.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<
        PerformanceEntry & { value: number; hadRecentInput: boolean }
      >) {
        if (!entry.hadRecentInput) w.__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });

  await page.goto("/", { waitUntil: "load" });
  await page.waitForTimeout(1_500); // let late paints and shifts land before reading
  const result = await page.evaluate(() => {
    const w = window as unknown as { __lcp: number; __cls: number };
    return { lcp: w.__lcp, cls: w.__cls };
  });
  await context.close();
  return result;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

for (const vp of viewports) {
  test(`shell home, ${vp.name}: LCP < ${BUDGET.lcpMs} ms and CLS < ${BUDGET.cls} (worst of ${RUNS})`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const lcps: number[] = [];
    const clss: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const { lcp, cls } = await measure(browser, vp);
      lcps.push(lcp);
      clss.push(cls);
    }
    const line = `vitals ${vp.name}: LCP median ${Math.round(median(lcps))} ms, worst ${Math.round(
      Math.max(...lcps),
    )} ms; CLS median ${median(clss).toFixed(4)}, worst ${Math.max(...clss).toFixed(4)}`;
    console.log(line);
    expect(Math.min(...lcps)).toBeGreaterThan(0);
    expect(Math.max(...lcps)).toBeLessThan(BUDGET.lcpMs);
    expect(Math.max(...clss)).toBeLessThan(BUDGET.cls);
  });
}
