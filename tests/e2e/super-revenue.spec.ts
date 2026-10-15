import { expect, test } from '@playwright/test';

import { adminClient, createTestRestaurant } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

// Revenue analytics (docs/SUPER_ADMIN_PLAN.md 13f; docs/DECISIONS.md SA-65+).

/** An India date, `offset` days from today's. */
function indiaDay(offset: number) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

test('revenue: key numbers, a movement’s restaurants, compared and grouped, the CSV', async ({
  page,
}) => {
  const db = adminClient();
  const team = await createPlatformAdmin('e2e-revenue');
  const restaurant = await createTestRestaurant({ prefix: 'e2e-revenue', plan: 'starter' });
  const { data: plan } = await db.from('plans').select('id').eq('code', 'starter').single();
  // Ten nights on trial, then ten paid: a New movement ten days ago.
  const paidFrom = indiaDay(-10);
  await db
    .from('metrics_subscription_daily')
    .insert(
      Array.from({ length: 20 }, (_, index) => {
        const day = indiaDay(index - 20);
        const paid = day >= paidFrom;
        return {
          day,
          restaurant_id: restaurant.restaurantId,
          state: paid ? 'paid' : 'trial',
          plan_id: plan!.id,
          billing_cycle: paid ? ('monthly' as const) : null,
          mrr_paise: paid ? 39900 : 0,
        };
      }),
    )
    .throwOnError();

  try {
    await logInAsPlatformAdmin(page, team);
    await page
      .getByRole('navigation', { name: 'Platform sections' })
      .getByRole('link', { name: 'Revenue' })
      .click();
    await expect(page.getByRole('heading', { name: 'Revenue', level: 1 })).toBeVisible();
    const numbers = page.getByRole('heading', { name: 'Key numbers' }).locator('..');
    await expect(numbers).toContainText('Net new MRR');
    await expect(numbers).toContainText('Expected in 30 days, incl. GST');

    // The last 30 days, by day: its New bar's restaurants.
    await page
      .getByRole('navigation', { name: 'Period' })
      .getByRole('link', { name: 'Last 30 days' })
      .click();
    await expect(page).toHaveURL(new RegExp(`from=${indiaDay(-29)}&to=${indiaDay(0)}`));
    const movement = page.getByRole('region', { name: 'MRR movement', exact: true });
    await expect(movement.getByRole('img', { name: /^MRR movement from / })).toBeVisible();
    await movement.getByText('Show as a table').click();
    await movement.locator(`a[href*="move=new&at=${paidFrom}"]`).click();
    await expect(page).toHaveURL(new RegExp(`move=new&at=${paidFrom}`));
    const list = page.getByRole('region', { name: /^New, / });
    const row = list.getByRole('row').filter({ hasText: restaurant.name });
    await expect(row).toContainText('Trial to Paid');
    await expect(row).toContainText('₹0');
    await expect(row).toContainText('₹399');
    await expect(row.getByRole('link', { name: restaurant.name })).toHaveAttribute(
      'href',
      `/super/restaurants/${restaurant.restaurantId}/billing`,
    );
    await list.getByRole('link', { name: 'Hide the list' }).click();
    await expect(page).not.toHaveURL(/move=/);

    // Compared with the 30 days before, then by week.
    await page.getByLabel('Compare with the previous period').check();
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(page).toHaveURL(/compare=1/);
    await expect(page.getByText(/^Compared with /)).toBeVisible();
    await expect(numbers).toContainText('the previous 30 days');
    await page
      .getByRole('navigation', { name: 'Group by' })
      .getByRole('link', { name: 'Weeks' })
      .click();
    await expect(page).toHaveURL(/by=week/);
    const mrr = page.getByRole('region', { name: 'MRR', exact: true });
    await mrr.getByText('Show as a table').click();
    await expect(mrr.getByRole('columnheader', { name: 'Week from' })).toBeVisible();

    // The period table as a CSV, for the page's dates and grouping.
    const href = await page.getByRole('link', { name: 'Export CSV' }).getAttribute('href');
    expect(href).toMatch(/\/super\/money\/revenue\/export\?.*by=week/);
    const response = await page.request.get(href!);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/csv');
    expect(response.headers()['content-disposition']).toContain(
      `revenue-${indiaDay(-29)}-to-${indiaDay(0)}.csv`,
    );
    expect(await response.text()).toContain('First day,Last day,MRR at the end');
  } finally {
    await db
      .from('metrics_subscription_daily')
      .delete()
      .eq('restaurant_id', restaurant.restaurantId)
      .throwOnError();
  }
});
