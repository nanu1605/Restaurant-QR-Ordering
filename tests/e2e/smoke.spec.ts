import { expect, test } from '@playwright/test';

import { APP_NAME } from '../../src/lib/config';

test('home page renders the placeholder', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: APP_NAME })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Dish progress' }).getByText('Preparing'),
  ).toBeVisible();
});

test('health endpoint reports a working database', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toMatchObject({ status: 'ok', db: 'ok' });
});
