import { expect, type Page, test } from '@playwright/test';

import { adminClient } from './helpers';
import {
  createLiveRestaurant,
  type LiveRestaurant,
  openLiveScreen,
  placeCustomerOrder,
  tableCard,
} from './live-fixtures';

// Billing (spec §10.5, §13.3, §15): void and reopen, what blocks a bill, split
// payments and the cash change calculator, plan limits, read-only restaurants,
// Total orders filters and the test print.

const LIVE = { timeout: 5_000 };

async function openBuilder(page: Page, label: string) {
  await page.goto('/admin/billing');
  await page.getByRole('link', { name: `Bill Table ${label}` }).click();
  await expect(page.getByRole('region', { name: `Bill for Table ${label}` })).toBeVisible();
}

async function assignWaiter(page: Page, name: string) {
  await page.getByRole('button', { name: /^(Assign|Reassign) waiter$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: new RegExp(name) }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`Waiter: ${name}`)).toBeVisible(LIVE);
}

/** Generates the bill from the builder, confirming unserved dishes if asked. */
async function generate(page: Page) {
  await page.getByRole('button', { name: 'Generate bill' }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: /^(Generate bill|Bill anyway)$/ }).click();
  await expect(page.getByRole('heading', { name: /^Bill INV\// })).toBeVisible();
  return page.url();
}

async function stubPrint(page: Page) {
  await page.context().addInitScript(() => {
    window.print = () => undefined;
  });
}

async function billTable(page: Page, r: LiveRestaurant, label: string, waiter = 'Ravi Kumar') {
  await placeCustomerOrder(r.tables[label]!.token, [{ menu_item_id: r.item.paneer, quantity: 1 }]);
  await openBuilder(page, label);
  await assignWaiter(page, waiter);
  return generate(page);
}

test('a manager voids a bill, reopens the table and bills it again', async ({
  browser,
  baseURL,
}) => {
  const r = await createLiveRestaurant({ approval: false });
  await placeCustomerOrder(r.tables['5']!.token, [{ menu_item_id: r.item.paneer, quantity: 2 }]);
  const { context, page } = await openLiveScreen(browser, r, 'owner', '/admin/billing', baseURL!);

  const row = page.getByRole('listitem').filter({ hasText: 'Table 5' });
  await expect(row).toContainText('2 items');
  await expect(row).toContainText('₹560.00');
  await expect(row).toContainText('2 not served');

  await openBuilder(page, '5');
  await assignWaiter(page, 'Ravi Kumar');
  await page.getByRole('button', { name: 'Generate bill' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('2 items not marked served — bill anyway?');
  await expect(confirm).toContainText('2 × Paneer Tikka · New');
  await confirm.getByRole('button', { name: 'Bill anyway' }).click();
  await expect(page.getByRole('heading', { name: /^Bill INV\/\d{4}-\d{2}\/00001$/ })).toBeVisible();

  await page.getByRole('button', { name: 'Void bill' }).click();
  const voidDialog = page.getByRole('dialog', { name: /^Void INV/ });
  await voidDialog.getByRole('radio', { name: 'Add more dishes' }).click();
  await voidDialog.getByRole('checkbox', { name: /Reopen table to add items/ }).click();
  await voidDialog.getByRole('button', { name: 'Void and reopen table' }).click();
  await page.waitForURL('**/admin/billing');

  // The table is open again with Ravi, and a new bill gets a new number.
  await openBuilder(page, '5');
  await expect(page.getByText('Waiter: Ravi Kumar')).toBeVisible();
  await generate(page);
  await expect(page.getByRole('heading', { name: /\/00002$/ })).toBeVisible();

  await page.goto('/admin/total-orders');
  await expect(page.getByRole('row', { name: /00001/ })).toContainText('VOID');
  await expect(page.getByRole('row', { name: /00002/ })).toBeVisible();
  await expect(page.getByLabel('Summary')).toContainText('Bills1');
  await page.getByRole('checkbox', { name: 'Hide void bills' }).check();
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByRole('row', { name: /00001/ })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /00002/ })).toBeVisible();
  await context.close();
});

test('a bill waits for approval and needs a waiter', async ({ browser, baseURL }) => {
  const r = await createLiveRestaurant({ approval: true });
  await placeCustomerOrder(r.tables['5']!.token, [{ menu_item_id: r.item.paneer, quantity: 1 }]);
  const { context, page } = await openLiveScreen(browser, r, 'owner', '/admin/billing', baseURL!);

  await expect(page.getByRole('listitem').filter({ hasText: 'Table 5' })).toContainText(
    'Waiting for approval',
  );
  await openBuilder(page, '5');
  await expect(page.getByText('An order is waiting for approval.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate bill' })).toBeDisabled();

  await page.getByRole('link', { name: 'Open Live orders' }).click();
  await tableCard(page, '5').click();
  await page
    .getByRole('dialog', { name: /^Table 5/ })
    .getByRole('button', { name: 'Approve round 1' })
    .click();
  await expect(tableCard(page, '5')).not.toHaveAttribute('data-state', 'needs_approval', LIVE);

  await openBuilder(page, '5');
  await expect(page.getByText('Assign a waiter before generating the bill.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate bill' })).toBeDisabled();
  await assignWaiter(page, 'Suresh Patel');
  await expect(page.getByRole('button', { name: 'Generate bill' })).toBeEnabled();
  await context.close();
});

test('split payments with the change calculator, and what Starter leaves out', async ({
  browser,
  baseURL,
}) => {
  const growth = await createLiveRestaurant({ approval: false });
  const owner = await openLiveScreen(browser, growth, 'owner', '/admin/billing', baseURL!);
  await billTable(owner.page, growth, '5'); // ₹280

  await owner.page.getByRole('button', { name: 'Record payment' }).click();
  const payment = owner.page.getByRole('dialog', { name: 'Record payment' });
  await payment.getByRole('textbox', { name: 'Cash received (₹)' }).fill('500');
  await expect(payment).toContainText('Change to return: ₹220.00');
  await payment.getByRole('textbox', { name: 'Amount (₹)' }).fill('200');
  await payment.getByRole('button', { name: 'Split payment' }).click();
  const second = payment.getByRole('group', { name: 'Payment 2', exact: true });
  await expect(second.getByRole('textbox', { name: 'Amount (₹)' })).toHaveValue('80.00');
  await expect(payment).toContainText('Payments add up to the total.');
  await payment
    .getByRole('group', { name: 'Payment 2 mode' })
    .getByRole('button', { name: 'Card' })
    .click();
  await payment.getByRole('button', { name: 'Record payment' }).click();
  await expect(payment).toBeHidden();
  const payments = owner.page.getByRole('region', { name: 'Payments' });
  await expect(payments).toContainText('Cash');
  await expect(payments).toContainText('Card');
  await owner.context.close();

  const starter = await createLiveRestaurant({ approval: false, plan: 'starter' });
  const starterOwner = await openLiveScreen(browser, starter, 'owner', '/admin/billing', baseURL!);
  await placeCustomerOrder(starter.tables['5']!.token, [
    { menu_item_id: starter.item.paneer, quantity: 1 },
  ]);
  await openBuilder(starterOwner.page, '5');
  await expect(starterOwner.page.getByText('Available on Growth.')).toBeVisible();
  await expect(starterOwner.page.getByRole('radio', { name: 'Percent (%)' })).toHaveCount(0);
  await assignWaiter(starterOwner.page, 'Ravi Kumar');
  await generate(starterOwner.page);
  await starterOwner.page.getByRole('button', { name: 'Record payment' }).click();
  const starterPayment = starterOwner.page.getByRole('dialog', { name: 'Record payment' });
  await expect(starterPayment).toContainText('Split payment: Available on Growth.');
  await expect(starterPayment.getByRole('button', { name: 'Split payment' })).toHaveCount(0);
  await starterOwner.context.close();
});

test('a read-only restaurant still bills its open table', async ({ browser, baseURL }) => {
  const r = await createLiveRestaurant({ approval: false });
  await placeCustomerOrder(r.tables['5']!.token, [{ menu_item_id: r.item.paneer, quantity: 1 }]);
  await adminClient()
    .from('restaurants')
    .update({ status: 'suspended', suspended_reason: 'E2E suspension' })
    .eq('id', r.restaurantId)
    .throwOnError();
  const { context, page } = await openLiveScreen(browser, r, 'owner', '/admin/billing', baseURL!);

  await openBuilder(page, '5');
  await assignWaiter(page, 'Ravi Kumar');
  await generate(page);
  await page.getByRole('button', { name: 'Record payment' }).click();
  const payment = page.getByRole('dialog', { name: 'Record payment' });
  await payment.getByRole('button', { name: 'Record payment' }).click();
  await expect(payment).toBeHidden();
  await expect(page.getByText('Paid', { exact: true })).toBeVisible();
  await context.close();
});

test('total orders filters bills and lists tables closed without a bill', async ({
  browser,
  baseURL,
}) => {
  const r = await createLiveRestaurant({ approval: false, maxTablesPerWaiter: 3 });
  const { context, page } = await openLiveScreen(browser, r, 'owner', '/admin/billing', baseURL!);

  await billTable(page, r, '4');
  await page.getByRole('button', { name: 'Record payment' }).click();
  let payment = page.getByRole('dialog', { name: 'Record payment' });
  await payment.getByRole('button', { name: 'Record payment' }).click();
  await expect(payment).toBeHidden();

  await billTable(page, r, '5', 'Suresh Patel');
  await page.getByRole('button', { name: 'Record payment' }).click();
  payment = page.getByRole('dialog', { name: 'Record payment' });
  await payment.getByRole('button', { name: 'UPI' }).click();
  await payment.getByRole('button', { name: 'Record payment' }).click();
  await expect(payment).toBeHidden();

  await placeCustomerOrder(r.tables['3']!.token, [{ menu_item_id: r.item.paneer, quantity: 1 }]);
  await page.goto('/admin/live');
  await tableCard(page, '3').click();
  await page
    .getByRole('dialog', { name: /^Table 3/ })
    .getByRole('button', { name: 'Close without bill' })
    .click();
  const close = page.getByRole('dialog', { name: 'Close Table 3 without a bill' });
  await close.getByRole('textbox', { name: 'Reason' }).fill('Walked out');
  await close.getByRole('button', { name: 'Close table' }).click();
  await expect(close).toBeHidden();

  await page.goto('/admin/total-orders');
  await expect(page.getByRole('row', { name: /INV\// })).toHaveCount(2);
  await expect(page.getByLabel('Summary')).toContainText('Net collected₹560.00');

  await page.getByRole('combobox', { name: 'Payment mode' }).selectOption('upi');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByRole('row', { name: /INV\// })).toHaveCount(1);
  await expect(page.getByRole('row', { name: /INV\// })).toContainText('Suresh Patel');

  await page.getByRole('link', { name: 'Clear filters' }).click();
  await expect(page.getByRole('row', { name: /INV\// })).toHaveCount(2);
  await expect(page.getByRole('combobox', { name: 'Payment mode' })).toHaveValue('');
  await page.getByRole('searchbox', { name: 'Invoice number' }).fill('00001');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByRole('row', { name: /INV\// })).toHaveCount(1);
  await expect(page.getByRole('row', { name: /INV\// })).toContainText('Ravi Kumar');

  await page.getByRole('link', { name: 'Closed without bill' }).click();
  const closedRow = page.getByRole('row', { name: /Walked out/ });
  await expect(closedRow).toContainText('3');
  await expect(closedRow).toContainText('Test Owner');
  await context.close();
});

test('test print shows a sample bill on 58 mm paper', async ({ browser, baseURL }) => {
  const r = await createLiveRestaurant();
  await adminClient()
    .from('restaurants')
    .update({ paper_width: '58mm', bill_footer_text: 'Thank you, visit again' })
    .eq('id', r.restaurantId)
    .throwOnError();
  const { context, page } = await openLiveScreen(browser, r, 'owner', '/admin/settings', baseURL!);

  await page.getByRole('tab', { name: 'Bill' }).click();
  await expect(page.getByRole('link', { name: 'Test print' })).toHaveAttribute(
    'href',
    '/admin/settings/test-print',
  );
  await stubPrint(page);
  await page.goto('/admin/settings/test-print');
  const sample = page.getByRole('article');
  await expect(sample).toContainText('TEST PRINT — NOT A BILL');
  await expect(sample).toContainText('Paneer Tikka');
  await expect(sample).toContainText('Rupees Seven Hundred Only');
  await expect(sample).toContainText('Thank you, visit again');
  // 48 mm printable width for 58 mm paper; the page size is left to the printer
  // driver, so no stylesheet (like the A4 QR sheet's) forces one.
  const width = await sample.evaluate((element) => element.getBoundingClientRect().width);
  expect(width).toBeCloseTo((48 * 96) / 25.4, 0);
  const pageSizes = await page.evaluate(() => {
    const sizes = (rules: CSSRuleList): string[] =>
      Array.from(rules).flatMap((rule) => {
        if (rule instanceof CSSPageRule) return [rule.style.getPropertyValue('size')];
        if (rule instanceof CSSGroupingRule) return sizes(rule.cssRules);
        return [];
      });
    return Array.from(document.styleSheets).flatMap((sheet) => sizes(sheet.cssRules));
  });
  expect(pageSizes.filter(Boolean)).toEqual([]);
  await context.close();
});
