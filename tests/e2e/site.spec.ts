import { expect, test } from '@playwright/test';

import { formatINR } from '../../src/lib/money';
import { adminClient, fakeTurnstile, watchCspViolations } from './helpers';

// The public website (docs/DECISIONS.md W-1 to W-6), on desktop, a tablet and
// a phone: sections, navigation, the hero scene, pricing, the policies.

test.beforeEach(async ({ context }) => {
  await fakeTurnstile(context);
});

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
    'Try it in your browser',
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

test('the sections and pages are reachable from the menu', async ({ page }) => {
  await page.goto('/');
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;
  const openMenuLink = async (name: string) => {
    if (wide) return page.getByRole('banner').getByRole('link', { name }).click();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('dialog').getByRole('link', { name }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  };
  await openMenuLink('How it works');
  await expect(page).toHaveURL(/#how$/);
  await expect(page.getByRole('heading', { name: 'How it works' })).toBeInViewport();

  await openMenuLink('Pricing');
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Simple plans for every size of restaurant',
  );
});

test('pricing shows the plans from the database and finds the right one', async ({
  page,
  context,
}) => {
  const violations = await watchCspViolations(context);
  const { data: plans } = await adminClient()
    .from('plans')
    .select('name, price_monthly_paise, price_yearly_paise, max_staff')
    .eq('is_active', true)
    .order('price_monthly_paise');
  expect(plans?.length).toBeGreaterThan(0);

  await page.goto('/pricing');
  const cards = page.getByRole('list', { name: 'Plans' });
  for (const plan of plans!) {
    await expect(cards.getByRole('listitem').filter({ hasText: plan.name }).first()).toContainText(
      `${formatINR(plan.price_monthly_paise, { fraction: 'auto' })} a month`,
    );
  }
  await page.getByRole('button', { name: /^Yearly/ }).click();
  for (const plan of plans!) {
    await expect(cards.getByRole('listitem').filter({ hasText: plan.name }).first()).toContainText(
      `${formatINR(plan.price_yearly_paise, { fraction: 'auto' })} a year`,
    );
  }

  // The most staff the helper asks about: only a plan without a staff limit fits.
  await page.getByLabel('Staff who sign in (not counting you)').fill('40');
  const unlimited = plans!.find((plan) => plan.max_staff === null);
  await expect(page.getByRole('status', { name: 'Recommended plan' })).toContainText(
    unlimited?.name ?? 'Let’s talk',
  );
  expect(violations).toEqual([]);
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

test('the features page shows each role on the real app', async ({ page }) => {
  await page.goto('/features');
  for (const name of [
    'Guests order from their own phone',
    'Waiters see every table at a glance',
    'The kitchen sees what to cook next',
    'Bills in one tap',
    'Owners and managers stay in charge',
  ]) {
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(name) })).toBeAttached();
  }
  await expect(page.getByRole('img', { name: /The waiters’ live board/ })).toBeAttached();
  await page
    .getByRole('navigation', { name: 'On this page' })
    .getByRole('link', { name: 'Billing' })
    .click();
  await expect(page).toHaveURL(/#billing$/);
  await expect(page.getByRole('heading', { name: 'Bills in one tap' })).toBeInViewport();
});

test('nothing scrolls sideways on a 320px screen', async ({ page, context }) => {
  const violations = await watchCspViolations(context);
  // 320 CSS px: the narrowest phones, or a desktop at 400% zoom (WCAG 1.4.10).
  await page.setViewportSize({ width: 320, height: 700 });
  for (const path of ['/', '/features', '/pricing', '/demo', '/contact', '/terms']) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  expect(violations).toEqual([]);
});
