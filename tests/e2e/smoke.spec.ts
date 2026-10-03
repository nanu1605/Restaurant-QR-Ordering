import { expect, test } from '@playwright/test';

test('the home page renders', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: /Your menu on every table/ }),
  ).toBeVisible();
});

test('health endpoint reports a working database', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toMatchObject({ status: 'ok', db: 'ok' });
});
