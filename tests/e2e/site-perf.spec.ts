import { expect, test } from '@playwright/test';

// Opt-in, against a production build:  PERF=1 pnpm e2e site-perf
// The website on customer-perf.spec.ts's throttled phone profile (docs/DECISIONS.md W-14):
// the largest paint within 2.5 s and layout shift under 0.1 on each page.
test.skip(!process.env.PERF, 'Set PERF=1 to measure the website on a throttled phone profile.');
test.skip(({ isMobile }) => !isMobile, 'The phone profile only.');

const PATHS = ['/', '/features', '/pricing', '/demo', '/contact', '/signup', '/terms'];

test('each website page paints within 2.5 s and holds still', async ({ page }) => {
  test.setTimeout(PATHS.length * 30_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  // Each page as a first visit, not with the previous page's scripts cached.
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  for (const path of PATHS) {
    await page.goto(path, { waitUntil: 'load' });
    const { lcp, cls } = await page.evaluate(
      () =>
        new Promise<{ lcp: number; cls: number }>((resolve) => {
          let lcp = 0;
          let cls = 0;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) lcp = entry.startTime;
          }).observe({ type: 'largest-contentful-paint', buffered: true });
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as (PerformanceEntry & {
              value: number;
              hadRecentInput: boolean;
            })[]) {
              if (!entry.hadRecentInput) cls += entry.value;
            }
          }).observe({ type: 'layout-shift', buffered: true });
          setTimeout(() => resolve({ lcp, cls }), 3000);
        }),
    );
    const result = `${path}: LCP ${Math.round(lcp)} ms, CLS ${cls.toFixed(3)}`;
    test.info().annotations.push({ type: 'perf', description: result });
    console.log(result);
    expect.soft(lcp, path).toBeLessThan(2500);
    expect.soft(cls, path).toBeLessThan(0.1);
  }
});
