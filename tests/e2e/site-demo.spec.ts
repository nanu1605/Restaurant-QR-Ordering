import { expect, test, type Page } from '@playwright/test';

import { watchCspViolations } from './helpers';

// The interactive demo at /demo: one table's order played on the guest phone,
// the kitchen tablet and the counter laptop, in the browser only. From 1024px
// all three show; below that a switcher shows one at a time.

const SWITCH = {
  'Guest phone': 'Guest phone',
  'Kitchen tablet': 'Kitchen',
  'Counter laptop': 'Counter',
} as const;

/** Opens /demo once its script runs: "Start again" is safe to press any time. */
async function load(page: Page) {
  await page.goto('/demo');
  const announced = page.getByRole('main').getByRole('status');
  await expect(async () => {
    await page.getByRole('button', { name: 'Start again' }).click();
    await expect(announced).toHaveText('The demo has started again.', { timeout: 500 });
  }).toPass();
  return announced;
}

/** The device's screen, through the switcher when the page has one. */
async function open(page: Page, device: keyof typeof SWITCH) {
  const switcher = page.getByRole('group', { name: 'Device to show' });
  if (await switcher.isVisible()) {
    await switcher.getByRole('button', { name: SWITCH[device] }).click();
  }
  const screen = page.getByRole('region', { name: device });
  await expect(screen).toBeVisible();
  return screen;
}

test('a visitor plays one table’s order from the menu to a paid bill', async ({
  page,
  context,
}) => {
  const violations = await watchCspViolations(context);
  const announced = await load(page);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Try MenuMesh in your browser' }),
  ).toBeVisible();

  // The guest's words switch to Hindi and back.
  let phone = await open(page, 'Guest phone');
  await phone.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(phone.getByRole('button', { name: 'पनीर टिक्का जोड़ें' })).toHaveText('जोड़ें');
  await expect(phone.getByText('टेबल 5')).toBeVisible();
  await phone.getByRole('button', { name: 'English' }).click();
  await expect(phone.getByText('Table 5')).toBeVisible();

  // Order: two Paneer Tikka and a Butter Naan.
  await phone.getByRole('button', { name: 'Add Paneer Tikka' }).click();
  await expect(phone.getByRole('button', { name: 'One more Paneer Tikka' })).toBeFocused();
  await phone.getByRole('button', { name: 'One more Paneer Tikka' }).click();
  await phone.getByRole('button', { name: 'Add Butter Naan' }).click();
  await expect(announced).toHaveText('Butter Naan added. 1 in cart.');
  const cartBar = phone.getByRole('button', { name: /View cart/ });
  await expect(cartBar).toContainText('3 items · ₹620');
  await cartBar.click();
  await phone.getByRole('button', { name: 'Place order' }).click();
  await expect(announced).toHaveText('Order sent to the kitchen.');
  await expect(phone.getByRole('heading', { name: 'Your table’s orders' })).toBeFocused();
  await expect(phone.getByText('Placed', { exact: true })).toHaveCount(2);
  await phone.getByRole('button', { name: 'Call waiter' }).click();
  await expect(phone.getByRole('button', { name: 'Waiter called' })).toBeVisible();

  // The kitchen answers the call and moves the dishes on.
  const kitchen = await open(page, 'Kitchen tablet');
  await expect(kitchen.getByText('Calling', { exact: true })).toBeVisible();
  await kitchen.getByRole('button', { name: /^Done\W+calling a waiter$/ }).click();
  await expect(kitchen.getByText('Calling', { exact: true })).toBeHidden();
  await kitchen.getByRole('button', { name: 'Start all in round 1' }).click();
  await expect(kitchen.getByText('Preparing', { exact: true })).toHaveCount(2);
  await kitchen.getByRole('button', { name: 'Mark ready Paneer Tikka' }).click();
  await expect(announced).toHaveText('Paneer Tikka is ready.');
  await kitchen.getByRole('button', { name: 'Mark ready Butter Naan' }).click();
  await kitchen.getByRole('button', { name: 'Mark all served in round 1' }).click();
  await expect(kitchen.getByText('All served')).toBeVisible();

  phone = await open(page, 'Guest phone');
  await expect(phone.getByText('Served', { exact: true })).toHaveCount(2);

  // The counter makes the bill (₹620 + 5% GST) and takes the payment.
  const counter = await open(page, 'Counter laptop');
  await counter.getByRole('button', { name: 'Make bill' }).click();
  await expect(counter).toContainText('₹31.00');
  await expect(counter).toContainText('₹651.00');
  await counter.getByRole('button', { name: 'UPI' }).click();
  await expect(counter.getByText('Paid · UPI')).toBeVisible();
  await expect(page.getByText(/^Next step: All done/)).toBeVisible();
  await expect(await open(page, 'Kitchen tablet')).toContainText('Free');

  await page.getByRole('button', { name: 'Start again' }).click();
  phone = await open(page, 'Guest phone');
  await expect(phone.getByRole('button', { name: 'Add Paneer Tikka' })).toBeVisible();
  expect(violations).toEqual([]);
});

test('“Show me” plays the next steps and stops when asked', async ({ page }) => {
  const announced = await load(page);
  await page.getByRole('button', { name: 'Show me' }).click();
  await expect(announced).toHaveText('Paneer Tikka added. 1 in cart.');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: 'Show me' })).toBeVisible();
});

test('with reduced motion there is no “Show me”', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load(page);
  await expect(page.getByRole('button', { name: 'Show me' })).toBeHidden();
});

test('the demo does not scroll sideways on a 320px screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await load(page);
  for (const device of ['Guest phone', 'Kitchen tablet', 'Counter laptop'] as const) {
    await open(page, device);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, device).toBeLessThanOrEqual(0);
  }
});
