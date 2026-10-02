import { expect, test } from '@playwright/test';

import { watchCspViolations } from './helpers';

// The public website (docs/DECISIONS.md W-1 to W-4), on desktop, a tablet and
// a phone: sections, navigation, the hero scene, the policies.

test('the home page tells the story and leads to a demo', async ({ page, context }) => {
  const violations = await watchCspViolations(context);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: /Your menu on every table/ }),
  ).toBeVisible();
  for (const name of [
    'How it works',
    'One system for the whole restaurant',
    'Made for restaurants in India',
    'Your menu, in your guests’ language',
    'Questions owners ask',
  ]) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeAttached();
  }

  // The scene is described in words and can be paused.
  const scene = page.getByRole('figure');
  await expect(scene.getByRole('listitem')).toHaveCount(5);
  await scene.getByRole('button', { name: 'Pause the animation' }).click();
  await expect(scene.getByRole('button', { name: 'Play the animation' })).toBeVisible();

  // An answer opens in place.
  const question = page.getByText('Do my guests need to install an app?');
  await question.click();
  await expect(
    page.getByText(/scan the QR code on the table with their phone camera/),
  ).toBeVisible();

  await page.getByRole('main').getByRole('link', { name: 'Book a demo' }).first().click();
  await expect(page).toHaveURL(/\/contact$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Book a demo' })).toBeVisible();
  expect(violations).toEqual([]);
});

test('the sections are reachable from the menu', async ({ page }) => {
  await page.goto('/');
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;
  if (!wide) {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'FAQ' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  } else {
    await page.getByRole('banner').getByRole('link', { name: 'FAQ' }).click();
  }
  await expect(page).toHaveURL(/#faq$/);
  await expect(page.getByRole('heading', { name: 'Questions owners ask' })).toBeInViewport();
});

test('on a phone the call to action follows the page down', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, 'The sticky bar is for phones.');
  await page.goto('/');
  const sticky = page.locator('div.fixed').filter({ hasText: 'Book a demo' });
  await expect(sticky).not.toBeInViewport();
  await page.getByRole('heading', { name: 'How it works' }).scrollIntoViewIfNeeded();
  await expect(sticky).toBeInViewport();
  await sticky.getByRole('link', { name: 'Book a demo' }).click();
  await expect(page).toHaveURL(/\/contact$/);
  // The bar belongs to the home page only.
  await expect(sticky).toHaveCount(0);
});

test('with reduced motion the scene shows the finished order', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const scene = page.getByRole('figure');
  await expect(scene.locator('figcaption p')).toHaveText(
    'The bill prints, and the payment is recorded.',
  );
  await expect(scene.getByText('Paid · UPI').filter({ visible: true })).toBeVisible();
  await expect(scene.getByRole('button', { name: /the animation$/ })).toBeHidden();
});

test('the policies are linked from every page footer', async ({ page }) => {
  await page.goto('/');
  const footer = page.getByRole('contentinfo');
  for (const [name, heading] of [
    ['Terms of service', 'Terms of service'],
    ['Privacy policy', 'Privacy policy'],
    ['Refunds and cancellation', 'Refunds and cancellation'],
    ['Shipping and delivery', 'Shipping and delivery'],
  ] as const) {
    await footer.getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
});

test('nothing scrolls sideways on a 320px screen', async ({ page }) => {
  // 320 CSS px: the narrowest phones, or a desktop at 400% zoom (WCAG 1.4.10).
  await page.setViewportSize({ width: 320, height: 700 });
  for (const path of ['/', '/contact', '/terms']) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
