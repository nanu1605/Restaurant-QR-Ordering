import { expect, test, type Page } from '@playwright/test';

import { adminClient, createTestRestaurant, logInWithCode } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

/**
 * Menu import (spec §20A, §19 Phase 7 "a phone photo of a menu gives a review
 * draft; importing creates the categories and dishes; a bad photo fails with a
 * clear message"). Photos go to a local stand-in reader
 * (tests/e2e/mock-vision-server.mjs).
 */

async function logInAsOwner(page: Page) {
  const restaurant = await createTestRestaurant({ prefix: 'imp' });
  await page.goto('/login');
  await logInWithCode(page, restaurant.slug, 'owner', restaurant.password);
  await expect(page).toHaveURL(/\/admin$/);
  return restaurant;
}

async function menuDishes(restaurantId: string) {
  const { data } = await adminClient()
    .from('menu_items')
    .select(
      'name, price_paise, food_type, is_active, category:menu_categories!inner (name, source), variants:menu_item_variants (name, price_paise, sort_order)',
    )
    .eq('restaurant_id', restaurantId)
    .throwOnError();
  return data!;
}

/** A JPEG made in the page: noise reads as a menu to the stand-in reader, white as blank. */
async function makePhoto(page: Page, width: number, height: number, blank = false) {
  const base64 = await page.evaluate(
    ({ width, height, blank }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      if (blank) {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
      } else {
        const image = context.createImageData(width, height);
        for (let i = 0; i < image.data.length; i += 4) {
          const value = (i * 2654435761) % 256;
          image.data[i] = value;
          image.data[i + 1] = (value * 7) % 256;
          image.data[i + 2] = (value * 13) % 256;
          image.data[i + 3] = 255;
        }
        context.putImageData(image, 0, 0);
      }
      return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
    },
    { width, height, blank },
  );
  return Buffer.from(base64, 'base64');
}

/** A minimal PDF with one line of text on each A4 page. */
function makePdf(pageCount: number): Buffer {
  const font = 3 + pageCount * 2;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  ];
  for (let i = 0; i < pageCount; i += 1) {
    const text = `BT /F1 36 Tf 72 700 Td (Menu page ${i + 1}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      [`<< /Length ${text.length} >>`, 'stream', text, 'endstream'].join('\n'),
    );
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const lines = ['%PDF-1.4'];
  let size = lines[0]!.length + 1;
  const offsets = objects.map((body, index) => {
    const offset = size;
    const object = [`${index + 1} 0 obj`, body, 'endobj'].join('\n');
    lines.push(object);
    size += object.length + 1;
    return offset;
  });
  lines.push(
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(size),
    '%%EOF',
  );
  return Buffer.from(`${lines.join('\n')}\n`, 'latin1');
}

const CSV = [
  'category,name,description,food_type,price,variant_name,variant_price',
  'starters,Paneer Tikka,"Cottage cheese, peppers",veg,280,,',
  'Starters,Chicken 65,,non_veg,,Half,180',
  'Starters,Chicken 65,,non_veg,,Full,320',
  'Tandoor,Tandoori Roti,,,30,,',
  'Tandoor,Water Bottle,,veg,2,,',
].join('\n');

test('a CSV is reviewed, imported, and importing it again adds nothing', async ({ page }) => {
  const restaurant = await logInAsOwner(page);
  await page.goto('/admin/menu');
  await page.getByRole('link', { name: 'Import menu' }).click();
  await expect(page).toHaveURL(/\/admin\/menu\/import$/);

  // A file with mistakes is refused row by row.
  await page.getByLabel('Menu CSV file').setInputFiles({
    name: 'broken.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('category,name,price\nStarters,,280\nStarters,Soup,abc'),
  });
  await expect(page.getByRole('list', { name: 'Rows to fix' })).toContainText(
    'Row 2: the dish name is missing.',
  );
  await expect(page.getByRole('list', { name: 'Rows to fix' })).toContainText('Row 3:');

  await page.getByLabel('Menu CSV file').setInputFiles({
    name: 'menu.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV),
  });
  await expect(page).toHaveURL(/\/admin\/menu\/import\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Check this before importing.')).toBeVisible();
  await expect(page.getByTestId('review-counts')).toHaveText(
    '2 categories found, 4 dishes found, 2 need a check.',
  );

  // Only the rows needing a check are listed at first.
  const roti = page.locator('li[data-row="Tandoori Roti"]');
  const water = page.locator('li[data-row="Water Bottle"]');
  await expect(page.locator('li[data-row="Paneer Tikka"]')).toHaveCount(0);
  await expect(roti.locator('[data-flag="food_type_unknown"]')).toHaveText(
    'Veg/non-veg not detected',
  );
  await expect(water.locator('[data-flag="price_range"]')).toBeVisible();

  await roti.getByRole('button', { name: 'Veg', exact: true }).click();
  await expect(roti.locator('[data-flag]')).toHaveCount(0);
  await water.getByLabel('Price of Water Bottle').fill('20');
  await expect(water.locator('[data-flag]')).toHaveCount(0);

  await page.getByRole('checkbox', { name: /Needs a check/ }).click();
  await expect(page.locator('li[data-row="Paneer Tikka"]')).toBeVisible();

  await page.getByRole('button', { name: 'Import 4 dishes into 2 categories' }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('region', { name: 'Import result' })).toContainText(
    '4 dishes added, 1 new category.',
  );

  const dishes = await menuDishes(restaurant.restaurantId);
  const byName = Object.fromEntries(dishes.map((dish) => [dish.name, dish]));
  expect(byName['Paneer Tikka']).toMatchObject({
    price_paise: 28000,
    category: { name: 'Starters', source: 'default' },
  });
  expect(byName['Chicken 65']!.variants.map((v) => [v.name, v.price_paise])).toEqual([
    ['Half', 18000],
    ['Full', 32000],
  ]);
  expect(byName['Tandoori Roti']).toMatchObject({
    food_type: 'veg',
    category: { name: 'Tandoor', source: 'import' },
  });
  expect(byName['Water Bottle']!.price_paise).toBe(2000);

  await page.getByRole('link', { name: 'Open the menu' }).click();
  await expect(page).toHaveURL(/\/admin\/menu$/);

  // The same file again: every dish is already on the menu and skipped.
  await page.goto('/admin/menu/import');
  await page.getByLabel('Menu CSV file').setInputFiles({
    name: 'menu.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV.replace('Tandoor,Tandoori Roti,,,30', 'Tandoor,Tandoori Roti,,veg,35')),
  });
  await expect(page.getByText('Check this before importing.')).toBeVisible();
  await page.getByRole('checkbox', { name: /Needs a check/ }).uncheck();
  await expect(page.getByText('Already in menu')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Nothing to import' })).toBeDisabled();

  // …but one price can be updated instead.
  await page
    .locator('li[data-row="Tandoori Roti"]')
    .getByLabel('What to do with Tandoori Roti')
    .selectOption('update_price');
  await page.getByRole('button', { name: 'Update 1 price' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('region', { name: 'Import result' })).toContainText(
    '1 price updated, 3 skipped.',
  );
  const after = await menuDishes(restaurant.restaurantId);
  expect(after).toHaveLength(4);
  expect(after.find((dish) => dish.name === 'Tandoori Roti')!.price_paise).toBe(3500);
});

test('a photo is read, checked and imported; a blank or tiny photo is refused', async ({
  page,
}) => {
  const restaurant = await logInAsOwner(page);
  await page.goto('/admin/menu/import');
  const photoCard = page.getByRole('region', { name: 'From photos or a PDF' });
  test.skip(
    !(await photoCard.isVisible()),
    'The running server has no menu reader configured (reuse of a dev server without the E2E env).',
  );

  // A PDF becomes one page photo per sheet (rendered in the browser).
  await page.getByLabel('Menu photos or PDF').setInputFiles({
    name: 'menu.pdf',
    mimeType: 'application/pdf',
    buffer: makePdf(2),
  });
  await expect(photoCard.getByRole('img', { name: 'Page 2: menu.pdf, page 2' })).toBeVisible();
  await photoCard.getByRole('button', { name: 'Remove page 2' }).click();
  await photoCard.getByRole('button', { name: 'Remove page 1' }).click();
  await expect(photoCard.getByRole('list', { name: 'Pages to read' })).toHaveCount(0);

  // Too small to read: refused before anything is uploaded.
  await page.getByLabel('Menu photos or PDF').setInputFiles({
    name: 'tiny.jpg',
    mimeType: 'image/jpeg',
    buffer: await makePhoto(page, 600, 800),
  });
  await expect(photoCard.getByRole('alert')).toHaveText(
    'tiny.jpg: This photo is too small to read. Take a closer photo of one page at a time.',
  );

  await page.getByLabel('Menu photos or PDF').setInputFiles({
    name: 'menu-page.jpg',
    mimeType: 'image/jpeg',
    buffer: await makePhoto(page, 1200, 1600),
  });
  await expect(photoCard.getByRole('img', { name: 'Page 1: menu-page.jpg' })).toBeVisible();
  await photoCard.getByRole('button', { name: 'Read 1 page' }).click();

  await expect(
    page.getByText('Check this before importing. Prices read from photos are often wrong.'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Show page 1' }).first()).toBeVisible();

  const kebab = page.locator('li[data-row="Hara Bhara Kebab"]');
  await expect(kebab.locator('[data-flag="price_missing"]')).toHaveText('Price missing');
  await expect(kebab).toContainText('Note: price unclear');
  const importButton = page.getByRole('button', { name: /^Import 4 dishes/ });
  await expect(importButton).toBeDisabled();
  await expect(page.getByText(/Fix or skip 1 row first: Hara Bhara Kebab/)).toBeVisible();

  await kebab.getByLabel('Price of Hara Bhara Kebab').fill('240');
  await expect(importButton).toBeEnabled();
  await importButton.click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('1 dish without a mark is imported as veg.');
  await expect(confirm.getByRole('button', { name: 'Import' })).toBeDisabled();
  await confirm.getByRole('checkbox').click();
  await confirm.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('region', { name: 'Import result' })).toContainText('4 dishes added');

  const dishes = await menuDishes(restaurant.restaurantId);
  expect(dishes.map((dish) => dish.name).sort()).toEqual([
    'Butter Naan',
    'Chicken Tikka',
    'Hara Bhara Kebab',
    'Paneer Tikka',
  ]);
  expect(dishes.find((dish) => dish.name === 'Hara Bhara Kebab')).toMatchObject({
    price_paise: 24000,
    food_type: 'veg',
  });
  const { data: row } = await adminClient()
    .from('menu_imports')
    .select('status, model, input_tokens, output_tokens, cost_paise')
    .eq('restaurant_id', restaurant.restaurantId)
    .single()
    .throwOnError();
  // 1500 in + 600 out at $0.75 / $3.75 per million tokens = $0.003375 × ₹96 → 32 paise.
  expect(row).toMatchObject({
    status: 'imported',
    model: 'google/gemini-3.8-flash',
    input_tokens: 1500,
    output_tokens: 600,
    cost_paise: 32,
  });

  // A blank photo: nothing can be read, and the owner is told why.
  await page.goto('/admin/menu/import');
  await page.getByLabel('Menu photos or PDF').setInputFiles({
    name: 'blank.jpg',
    mimeType: 'image/jpeg',
    buffer: await makePhoto(page, 1200, 1600, true),
  });
  await page.getByRole('button', { name: 'Read 1 page' }).click();
  const result = page.getByRole('region', { name: 'Import result' });
  await expect(result).toContainText('This import could not be read.', { timeout: 30_000 });
  await expect(result).toContainText('No dishes could be read from these photos.');
});

test('a platform admin imports a menu for a restaurant', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'simp' });
  await logInAsPlatformAdmin(page, await createPlatformAdmin());
  await page.goto(`/super/restaurants/${restaurant.restaurantId}`);
  await page.getByRole('main').getByRole('link', { name: 'Import menu' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    `Import menu for ${restaurant.name}`,
  );

  await page.getByLabel('Menu CSV file').setInputFiles({
    name: 'menu.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'category,name,food_type,price\nChaat,Pani Puri,veg,60\nChaat,Bhel Puri,veg,80',
    ),
  });
  await page.getByRole('button', { name: 'Import 2 dishes into 1 category' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('region', { name: 'Import result' })).toContainText(
    '2 dishes added, 1 new category.',
  );

  expect((await menuDishes(restaurant.restaurantId)).map((dish) => dish.name).sort()).toEqual([
    'Bhel Puri',
    'Pani Puri',
  ]);
  await page.goto(`/super/audit?restaurant=${restaurant.restaurantId}&action=menu.imported`);
  await expect(page.locator('tr[data-action="menu.imported"]')).toHaveCount(1);
  await expect(page.locator('tr[data-action="menu.imported"]')).toContainText('Platform admin');
});

test('the daily cleanup deletes old import photos and refuses callers without the secret', async ({
  request,
}) => {
  expect((await request.get('/api/cron/daily')).status()).toBe(401);
  expect(
    (await request.get('/api/cron/daily', { headers: { Authorization: 'Bearer wrong' } })).status(),
  ).toBe(401);

  const restaurant = await createTestRestaurant({ prefix: 'cron' });
  const db = adminClient();
  const id = crypto.randomUUID();
  const path = `${restaurant.restaurantId}/${id}/page-1.jpg`;
  await db.storage
    .from('menu-imports')
    .upload(path, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { contentType: 'image/jpeg' })
    .then(({ error }) => {
      if (error) throw error;
    });
  await db
    .from('menu_imports')
    .insert({
      id,
      restaurant_id: restaurant.restaurantId,
      source: 'photo',
      status: 'imported',
      page_count: 1,
      file_paths: [path],
      completed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .throwOnError();

  const response = await request.get('/api/cron/daily', {
    headers: { Authorization: 'Bearer e2e-cron-secret' },
  });
  test.skip(
    response.status() === 401,
    'The running server has no CRON_SECRET for E2E (reuse of a dev server without the E2E env).',
  );
  expect(response.status()).toBe(200);
  expect((await response.json()).menuImports.imports).toBeGreaterThanOrEqual(1);

  const { data: row } = await db
    .from('menu_imports')
    .select('files_removed_at')
    .eq('id', id)
    .single()
    .throwOnError();
  expect(row!.files_removed_at).not.toBeNull();
  const { data: left } = await db.storage
    .from('menu-imports')
    .list(`${restaurant.restaurantId}/${id}`);
  expect(left ?? []).toHaveLength(0);
});
