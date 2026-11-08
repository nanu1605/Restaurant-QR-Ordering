import { expect, test } from '@playwright/test';

// Read-only checks for a deployed site (docs/DECISIONS.md P10-7): run after
// every staging and production deploy, and in CI against `next start`. They
// create nothing, so no test data or known passwords land in a real database.

test('the health check reaches the database, on the build just deployed', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  const health = await response.json();
  expect(health).toMatchObject({ status: 'ok', db: 'ok' });
  // After a deploy: a rolled-back Vercel project keeps serving the old build.
  if (process.env.EXPECTED_VERSION) expect(health.version).toBe(process.env.EXPECTED_VERSION);
});

// The liveness route for local checks, with no database behind it (docs/DECISIONS.md VPS-17).
test('the liveness check answers without the database', async ({ request }) => {
  const response = await request.get('/api/live');
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  const live = await response.json();
  expect(live).toMatchObject({ status: 'ok' });
  if (process.env.EXPECTED_VERSION) expect(live.version).toBe(process.env.EXPECTED_VERSION);
});

test('the login page loads under the security headers', async ({ page }) => {
  const response = await page.goto('/login');
  expect(response?.status()).toBe(200);
  const headers = response!.headers();
  const nonce = /'nonce-([^']+)'/.exec(headers['content-security-policy'] ?? '')?.[1];
  expect(nonce).toBeTruthy();
  expect(await response!.text()).toContain(`nonce="${nonce}"`);
  expect(headers['x-frame-options']).toBe('DENY');
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
});

test('a QR code that does not work gets the friendly page', async ({ page }) => {
  const response = await page.goto('/t/ZZZZZZZZZZZZZZZZ');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'This QR code isn’t working' })).toBeVisible();
});

test('the staff app can be installed', async ({ request }) => {
  const manifest = await request.get('/app.webmanifest');
  expect(await manifest.json()).toMatchObject({ start_url: '/login', display: 'standalone' });
  const icon = await request.get('/icon/192');
  expect(icon.headers()['content-type']).toBe('image/png');
});

test('search engines find the sitemap, and only menumesh.in may be indexed', async ({
  request,
  baseURL,
}) => {
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toMatch(/Sitemap: \S+\/sitemap\.xml/);
  expect((await request.get('/sitemap.xml')).status()).toBe(200);
  // docs/DECISIONS.md W-12: staging and every other host send noindex.
  const robotsTag = (await request.get('/')).headers()['x-robots-tag'];
  if (new URL(baseURL!).hostname === 'menumesh.in') expect(robotsTag).toBeUndefined();
  else expect(robotsTag).toBe('noindex');
});

test('the website counts visits without cookies or storage, and diners never load PostHog', async ({
  page,
  context,
}) => {
  // docs/DECISIONS.md W-13. Nothing reaches PostHog from here: each request is noted, then dropped.
  const sent: string[] = [];
  await context.route(/\.i\.posthog\.com\//, (route) => {
    sent.push(route.request().url());
    return route.abort();
  });
  const response = await page.goto('/pricing');
  const csp = response!.headers()['content-security-policy'] ?? '';
  // Production always has a key (docs/RUNBOOK.md "Launching the website").
  if (new URL(page.url()).hostname === 'menumesh.in') expect(csp).toMatch(/posthog\.com/);
  // PostHog is only in the policy where it has a key. It sends no events from an automated
  // browser, so its first request (its settings) shows it loaded.
  if (/posthog\.com/.test(csp)) {
    await expect.poll(() => sent.length, { timeout: 15_000 }).toBeGreaterThan(0);
  }
  const kept = await page.evaluate(() => [
    ...Object.keys(localStorage),
    ...Object.keys(sessionStorage),
    ...document.cookie.split(';').map((cookie) => cookie.split('=')[0]!.trim()),
  ]);
  expect(kept.filter((name) => /^ph_|posthog|^__ph/i.test(name))).toEqual([]);
  expect((await context.cookies()).filter((cookie) => /^ph_|posthog/i.test(cookie.name))).toEqual(
    [],
  );

  sent.length = 0;
  await page.goto('/t/ZZZZZZZZZZZZZZZZ');
  await page.waitForTimeout(5_000);
  expect(sent).toEqual([]);
});

test('the website shows its plans, and the policies are up', async ({ page, context, request }) => {
  // Nothing reaches PostHog from here (docs/DECISIONS.md W-13).
  await context.route(/\.i\.posthog\.com\//, (route) => route.abort());
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.goto('/pricing');
  const plans = page.getByRole('list', { name: 'Plans' }).getByRole('listitem');
  await expect(plans.first()).toContainText('₹');
  for (const path of ['/terms', '/privacy', '/refund', '/shipping']) {
    expect((await request.get(path)).status(), path).toBe(200);
  }
});

test('the website answers in Hindi under /hi', async ({ page, context }) => {
  // Nothing reaches PostHog from here (docs/DECISIONS.md W-13).
  await context.route(/\.i\.posthog\.com\//, (route) => route.abort());
  await page.goto('/hi');
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const english = await page
    .locator('link[rel="alternate"][hreflang="en-IN"]')
    .getAttribute('href');
  expect(new URL(english!).pathname).toBe('/');
});

test('the cron and the payment webhook refuse strangers', async ({ request }) => {
  expect((await request.get('/api/cron/daily')).status()).toBe(401);
  const webhook = await request.post('/api/webhooks/razorpay', {
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'wrong' },
    data: '{}',
  });
  // 400: a bad signature; 503: Razorpay isn't set up here yet.
  expect([400, 503]).toContain(webhook.status());
});
