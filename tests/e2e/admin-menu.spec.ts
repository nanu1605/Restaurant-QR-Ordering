import { expect, test, type Page } from '@playwright/test';

import { createOrderingTable } from './customer-fixtures';
import { adminClient, createTestRestaurant, logInAsOwner, makePng } from './helpers';

// Spec §19 Phase 2 acceptance: a new restaurant already has sensible
// categories; the owner renames one, hides one, adds "Jain Special" and builds
// a menu with images and variants.

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const categories = (page: Page) => page.getByRole('region', { name: 'Categories' });
// The select button reads "<name> <dish count>"; match the whole name so
// "Burgers" doesn't also match "Burgers & Wraps".
const categoryName = (name: string) => new RegExp(`^${escape(name)} \\d+$`);
const categoryButton = (page: Page, name: string) =>
  categories(page).getByRole('button', { name: categoryName(name) });
const categoryRow = (page: Page, name: string) =>
  categories(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: categoryName(name) }) });
const dishes = (page: Page) =>
  page.getByRole('region').filter({ has: page.locator('#items-heading') });
const dishRow = (page: Page, name: string) =>
  dishes(page).getByRole('listitem').filter({ hasText: name });

async function openCategoryActions(page: Page, name: string) {
  await categories(page)
    .getByRole('button', { name: `Actions for ${name}`, exact: true })
    .click();
}

test('owner builds a menu from the default categories', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'menu' });
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/menu');

  // The default north Indian set is already there.
  await expect(categories(page).getByRole('listitem')).toHaveCount(12);
  await expect(categoryRow(page, 'Tandoori & Kebabs')).toBeVisible();

  // Rename one.
  await openCategoryActions(page, 'Salads');
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = categories(page).getByRole('textbox', { name: 'Rename Salads' });
  await rename.fill('Fresh Salads');
  await rename.press('Enter');
  await expect(categoryRow(page, 'Fresh Salads')).toBeVisible();

  // Hide one; it moves to a collapsed "Hidden" section.
  await openCategoryActions(page, 'Soups');
  await page.getByRole('menuitem', { name: 'Hide' }).click();
  await expect(categories(page).getByText('Hidden (1)')).toBeVisible();
  await expect(categories(page).getByRole('listitem')).toHaveCount(11);

  // Add "Jain Special" with the always-visible field; it becomes the selection.
  await categories(page).getByRole('textbox', { name: 'New category name' }).fill('Jain Special');
  await categories(page).getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Jain Special' })).toBeVisible();
  await expect(page.getByText('No dishes in Jain Special yet')).toBeVisible();

  // A dish with a photo.
  await dishes(page).getByRole('button', { name: 'Add dish' }).first().click();
  let dialog = page.getByRole('dialog', { name: 'Add a dish' });
  await dialog.getByLabel('Dish name').fill('Jain Pav Bhaji');
  await dialog.getByLabel('Hindi name (optional)').fill('जैन पाव भाजी');
  await dialog.getByLabel('Description (optional)').fill('No onion, no garlic');
  await dialog.getByLabel('Price', { exact: true }).fill('150');
  await dialog.getByLabel('Photo (optional)').setInputFiles({
    name: 'pav-bhaji.png',
    mimeType: 'image/png',
    buffer: makePng(),
  });
  await expect(dialog.getByRole('img', { name: 'Dish photo preview' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Add dish' }).click();
  await expect(dialog).toBeHidden();

  const pavBhaji = dishRow(page, 'Jain Pav Bhaji');
  const pavBhajiPrice = pavBhaji.getByRole('button', { name: /Change price of Jain Pav Bhaji/ });
  await expect(pavBhaji).toBeVisible();
  await expect(pavBhaji).toContainText('जैन पाव भाजी');
  await expect(pavBhajiPrice).toHaveText('₹150');
  await expect(pavBhaji.locator('img')).toHaveAttribute('src', /\/menu-images\/.+\.webp\?v=/);

  // A dish with Half / Full options.
  await dishes(page).getByRole('button', { name: 'Add dish' }).first().click();
  dialog = page.getByRole('dialog', { name: 'Add a dish' });
  await dialog.getByLabel('Dish name').fill('Paneer Butter Masala');
  await dialog
    .getByRole('switch', { name: 'This dish has options with their own prices, e.g. Half / Full' })
    .click();
  await dialog.getByLabel('Option 1 name').fill('Half');
  await dialog.getByLabel('Option 1 price in rupees').fill('220');
  await dialog.getByLabel('Option 2 name').fill('Full');
  await dialog.getByLabel('Option 2 price in rupees').fill('380');
  await dialog.getByRole('button', { name: 'Add dish' }).click();
  await expect(dialog).toBeHidden();
  const paneer = dishRow(page, 'Paneer Butter Masala');
  await expect(paneer).toContainText('from ₹220');
  await expect(paneer).toContainText('2 options: Half, Full');

  // Options need distinct names.
  await paneer.getByRole('button', { name: 'Edit Paneer Butter Masala' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit Paneer Butter Masala' });
  await dialog.getByLabel('Option 2 name').fill('half');
  await dialog.getByRole('button', { name: 'Save dish' }).click();
  await expect(dialog.getByText('Each option needs its own name.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // Quick price edit.
  await pavBhajiPrice.click();
  const priceInput = pavBhaji.getByRole('textbox', { name: 'Price of Jain Pav Bhaji in rupees' });
  await priceInput.fill('160');
  await priceInput.press('Enter');
  await expect(pavBhajiPrice).toHaveText('₹160');

  // Out of stock (the switch updates at once; wait for the save too).
  const stockSaved = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/admin/menu'),
  );
  await pavBhaji.getByRole('switch', { name: 'Jain Pav Bhaji in stock' }).click();
  await expect(pavBhaji.getByText('Sold out')).toBeVisible();
  await stockSaved;

  // Reorder with the keyboard: Paneer Butter Masala moves above Jain Pav Bhaji.
  // Wait for each step like a person would: pick up, see it move, then drop.
  const moveHandle = paneer.getByRole('button', { name: 'Move Paneer Butter Masala' });
  await moveHandle.focus();
  await page.keyboard.press('Space');
  await expect(page.getByText('Picked up Paneer Butter Masala.')).toBeAttached();
  // dnd-kit starts listening for arrow keys a tick after pick-up; retry the press.
  await expect(async () => {
    await page.keyboard.press('ArrowUp');
    await expect(page.getByText('Paneer Butter Masala is over Jain Pav Bhaji.')).toBeAttached({
      timeout: 500,
    });
  }).toPass();
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/admin/menu'),
  );
  await page.keyboard.press('Space');
  await expect(dishes(page).getByRole('listitem').first()).toContainText('Paneer Butter Masala');
  await saved;
  await page.reload();
  await categoryButton(page, 'Jain Special').click();
  await expect(dishes(page).getByRole('listitem').first()).toContainText('Paneer Butter Masala');

  // Remove the photo again (exercises the storage delete policy).
  await pavBhaji.getByRole('button', { name: 'Edit Jain Pav Bhaji' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit Jain Pav Bhaji' });
  await dialog.getByRole('button', { name: 'Remove photo' }).click();
  await dialog.getByRole('button', { name: 'Save dish' }).click();
  await expect(dialog).toBeHidden();
  await expect(pavBhaji.locator('img')).toHaveCount(0);

  // Hide a dish, then bring it back.
  await pavBhaji.getByRole('button', { name: 'Hide Jain Pav Bhaji' }).click();
  await expect(dishes(page).getByText('Hidden dishes (1)')).toBeVisible();
  await dishes(page).getByText('Hidden dishes (1)').click();
  await dishes(page).getByRole('button', { name: 'Show Jain Pav Bhaji again' }).click();
  await expect(dishes(page).getByText('Hidden dishes (1)')).toBeHidden();
  // Editing the dish kept its Hindi name.
  await expect(pavBhaji).toContainText('जैन पाव भाजी');

  // A Hindi name for the category, shown after its name.
  await openCategoryActions(page, 'Jain Special');
  await page.getByRole('menuitem', { name: 'Hindi name' }).click();
  const hindiName = categories(page).getByRole('textbox', { name: 'Hindi name for Jain Special' });
  await hindiName.fill('जैन स्पेशल');
  await hindiName.press('Enter');
  await expect(
    categories(page).getByRole('button', { name: /^Jain Special जैन स्पेशल \d+$/ }),
  ).toBeVisible();
});

test('suggested categories add only what is missing, and deleting moves dishes', async ({
  page,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'menu', cuisine: 'cafe' });
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/menu');
  await expect(categories(page).getByRole('listitem')).toHaveCount(11);

  // The fast food set overlaps the café set (Fries & Sides) only in part.
  await categories(page).getByRole('button', { name: 'Add suggested categories' }).click();
  const suggest = page.getByRole('dialog', { name: 'Add suggested categories' });
  await suggest.getByLabel('Set').click();
  await page.getByRole('option', { name: 'Fast food' }).click();
  await expect(suggest.getByRole('listitem').filter({ hasText: 'Fries & Sides' })).toHaveCount(0);
  await expect(suggest.getByRole('listitem').filter({ hasText: 'Momos' })).toBeVisible();
  await suggest.getByRole('button', { name: /^Add \d+ categories$/ }).click();
  await expect(suggest).toBeHidden();
  await expect(categoryRow(page, 'Momos')).toBeVisible();

  // Put a dish in Momos, then delete the category and move the dish.
  await categoryButton(page, 'Momos').click();
  await dishes(page).getByRole('button', { name: 'Add dish' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a dish' });
  await dialog.getByLabel('Dish name').fill('Veg Momos');
  await dialog.getByLabel('Price', { exact: true }).fill('120');
  await dialog.getByRole('button', { name: 'Add dish' }).click();
  await expect(dialog).toBeHidden();

  await openCategoryActions(page, 'Momos');
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete “Momos”?' });
  await expect(confirm.getByRole('button', { name: 'Move dishes and delete' })).toBeDisabled();
  await confirm.getByLabel('Move dishes to').click();
  await page.getByRole('option', { name: 'Burgers', exact: true }).click();
  await confirm.getByRole('button', { name: 'Move dishes and delete' }).click();
  await expect(confirm).toBeHidden();
  await expect(categoryRow(page, 'Momos')).toHaveCount(0);

  await categoryButton(page, 'Burgers').click();
  await expect(dishRow(page, 'Veg Momos')).toBeVisible();
});

// Automatic Hindi names (docs/DECISIONS.md HN-5 to HN-8). The e2e menu reader
// knows only a few words (tests/e2e/mock-apis.mjs), so these names are made up
// of them.
test('a dish saved without a Hindi name gets one automatically', async ({ page }) => {
  const table = await createOrderingTable({ approval: false, prefix: 'hiauto' });
  const automatic = async () =>
    (
      await adminClient()
        .from('menu_items')
        .select('name, name_hi_auto')
        .eq('restaurant_id', table.restaurantId)
        .like('name', 'Masala Chai%')
        .single()
        .throwOnError()
    ).data;

  await logInAsOwner(page, table.restaurant);
  // The names come from the menu reader stand-in, like the photo import's.
  await page.goto('/admin/menu/import');
  test.skip(
    !(await page.getByRole('region', { name: 'From photos or a PDF' }).isVisible()),
    'The running server has no menu reader configured (reuse of a dev server without the E2E env).',
  );
  await page.goto('/admin/menu');
  await categoryButton(page, 'Starters').click();
  await dishes(page).getByRole('button', { name: 'Add dish' }).first().click();
  let dialog = page.getByRole('dialog', { name: 'Add a dish' });
  await dialog.getByLabel('Dish name').fill('Masala Chai');
  await dialog.getByLabel('Price', { exact: true }).fill('40');
  await dialog.getByRole('button', { name: 'Add dish' }).click();
  await expect(dialog).toBeHidden();

  // Written once the save has answered.
  await expect
    .poll(automatic, { timeout: 15_000 })
    .toEqual({ name: 'Masala Chai', name_hi_auto: 'मसाला चाय' });
  await page.reload();
  const chai = dishRow(page, 'Masala Chai');
  await expect(chai).toContainText('Masala Chai मसाला चाय (auto)');

  // The form offers it without filling the field; a rename writes a new one.
  await chai.getByRole('button', { name: 'Edit Masala Chai' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit Masala Chai' });
  const hindi = dialog.getByLabel('Hindi name (optional)');
  await expect(hindi).toHaveValue('');
  await expect(hindi).toHaveAttribute('placeholder', 'मसाला चाय');
  await dialog.getByLabel('Dish name').fill('Masala Chai Kadak');
  await dialog.getByRole('button', { name: 'Save dish' }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(automatic, { timeout: 15_000 })
    .toEqual({ name: 'Masala Chai Kadak', name_hi_auto: 'मसाला चाय कड़क' });

  // Guests on the Hindi menu see it.
  await page.goto(table.url);
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.getByRole('heading', { name: 'मसाला चाय कड़क' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chicken 65 जोड़ें' })).toBeVisible();
});
