import { expect, test } from '@playwright/test';

import { adminClient } from './helpers';
import { createLiveRestaurant } from './live-fixtures';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';
import { billTable, ownerClient } from './report-fixtures';

// Usage analytics (docs/SUPER_ADMIN_PLAN.md 13e; docs/DECISIONS.md SA-61 to SA-64).

/** A business date in India, `offset` days from today's (days start at 4 am). */
function businessDay(offset: number) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() - 4 * 60 * 60 * 1000),
  );
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

test('usage for today, compared, by city, grouped and ranked; a restaurant’s features', async ({
  page,
}) => {
  const db = adminClient();
  const team = await createPlatformAdmin('e2e-usage');
  const restaurant = await createLiveRestaurant({ approval: false });
  const city = `Usage ${restaurant.slug}`;
  await db.from('restaurants').update({ city }).eq('id', restaurant.restaurantId).throwOnError();
  await billTable(await ownerClient(restaurant), restaurant, {
    table: '3',
    discountBps: 1000,
    discountReason: 'Regular',
  });
  // A stored day in its last 30 finished ones, with a bill paid in two payments.
  await db
    .from('metrics_usage_daily')
    .insert({
      restaurant_id: restaurant.restaurantId,
      business_day: businessDay(-2),
      orders: 1,
      bills: 1,
      split_bills: 1,
      hourly_orders: Array(24).fill(0),
    })
    .throwOnError();

  try {
    await logInAsPlatformAdmin(page, team);
    await page
      .getByRole('navigation', { name: 'Platform sections' })
      .getByRole('link', { name: 'Usage' })
      .click();
    await expect(page.getByRole('heading', { name: 'Usage', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Key numbers' })).toBeVisible();

    // Today: the bill just made is in its city's row, linking to its restaurants.
    await page
      .getByRole('navigation', { name: 'Period' })
      .getByRole('link', { name: 'Today', exact: true })
      .click();
    const today = businessDay(0);
    await expect(page).toHaveURL(new RegExp(`from=${today}&to=${today}`));
    const row = page
      .getByRole('region', { name: 'By city' })
      .first()
      .getByRole('row')
      .filter({ hasText: city });
    await expect(row).toContainText('1 active');
    await expect(row.getByRole('link', { name: city })).toHaveAttribute(
      'href',
      `/super/restaurants?city=${encodeURIComponent(city).replace(/%20/g, '+')}`,
    );

    // Compared with the day before.
    await page.getByLabel('Compare with the previous period').check();
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(page).toHaveURL(/compare=1/);
    await expect(page.getByText(/^Compared with /)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Key numbers' }).locator('..')).toContainText(
      'the day before',
    );

    // Weeks, and the numbers as a table.
    await page
      .getByRole('navigation', { name: 'Group by' })
      .getByRole('link', { name: 'Weeks' })
      .click();
    await expect(page).toHaveURL(/by=week/);
    const chart = page.getByRole('region', { name: 'GMV and orders', exact: true });
    await expect(chart.getByRole('img', { name: /^GMV and orders from / })).toBeVisible();
    await chart.getByText('Show as a table').click();
    await expect(chart.getByRole('columnheader', { name: 'Week from' })).toBeVisible();

    await page
      .getByRole('navigation', { name: 'Rank places and plans by' })
      .getByRole('link', { name: 'Restaurants' })
      .click();
    await expect(page).toHaveURL(/rank=restaurants/);
    const features = page.getByRole('region', { name: 'Features in use' }).first();
    await expect(features.getByRole('row').filter({ hasText: 'Split payments' })).toBeVisible();

    // Its Usage tab: the stored split bill counts; today's discount isn't in
    // its last 30 finished days yet.
    await page.goto(`/super/restaurants/${restaurant.restaurantId}/usage`);
    const used = page.getByRole('region', { name: 'Features in use' });
    await expect(used).toContainText('Split payments: used');
    await expect(used).toContainText('Discounts: not used');
  } finally {
    await db
      .from('metrics_usage_daily')
      .delete()
      .eq('restaurant_id', restaurant.restaurantId)
      .throwOnError();
  }
});
