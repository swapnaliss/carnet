import { expect, test } from "@playwright/test";

// Core Web Vitals on the shell home against the production build (`next start`). The profile mimics
// Lighthouse's mobile throttling so the numbers are not flattered by a fast laptop: CPU slowed 4x
// and the network shaped to 1.6 Mbit/s down, 750 kbit/s up, 150 ms RTT. Budgets: LCP < 2.5 s,
// CLS < 0.1 (docs/design/performance.md). Each run prints a `vitals` line that the doc records.
const RUNS = 3;

test("shell home meets LCP < 2.5 s and CLS < 0.1 under mobile throttling", async ({ browser }) => {
  const lcps: number[] = [];
  const clss: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
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
    const { lcp, cls } = await page.evaluate(() => {
      const w = window as unknown as { __lcp: number; __cls: number };
      return { lcp: w.__lcp, cls: w.__cls };
    });
    console.log(`vitals run ${run + 1}: LCP ${Math.round(lcp)} ms, CLS ${cls.toFixed(4)}`);
    lcps.push(lcp);
    clss.push(cls);
    await context.close();
  }
  const worstLcp = Math.max(...lcps);
  const worstCls = Math.max(...clss);
  console.log(
    `vitals worst of ${RUNS}: LCP ${Math.round(worstLcp)} ms, CLS ${worstCls.toFixed(4)}`,
  );
  expect(worstLcp).toBeGreaterThan(0);
  expect(worstLcp).toBeLessThan(2_500);
  expect(worstCls).toBeLessThan(0.1);
});
