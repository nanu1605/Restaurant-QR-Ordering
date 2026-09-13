import { expect, test } from '@playwright/test';

// Spec §13.1 / §17: the customer menu reaches LCP < 2.5 s on a mid-range
// Android over 4G. Opt-in, against a production build:
//   PERF=1 pnpm e2e customer-perf --project=mobile
// Throttling follows Lighthouse's mobile profile: 150 ms RTT, 1.6 Mbps down,
// 750 kbps up, 4x CPU slowdown.
test.skip(!process.env.PERF, 'Set PERF=1 to measure the menu on a throttled phone profile.');

test('the menu reaches its largest paint within 2.5 s on a throttled phone', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  await page.goto('/t/DEMO0000TABLE001', { waitUntil: 'load' });
  await expect(page.getByRole('heading', { name: 'Paneer Tikka' })).toBeVisible();

  const lcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          resolve(entries[entries.length - 1]!.startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      }),
  );
  const scriptBytes = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((entry) => (entry as PerformanceResourceTiming).initiatorType === 'script')
      .reduce((sum, entry) => sum + (entry as PerformanceResourceTiming).encodedBodySize, 0),
  );

  const summary = `LCP ${Math.round(lcp)} ms, JS ${Math.round(scriptBytes / 1024)} KiB (compressed)`;
  test.info().annotations.push({ type: 'menu performance', description: summary });
  console.log(`Customer menu: ${summary}`);
  expect(lcp).toBeLessThan(2500);
});
