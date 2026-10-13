import { randomUUID } from 'node:crypto';

import { expect, type Locator, type Page, test } from '@playwright/test';

import { onboardRestaurant } from '../../src/features/platform/onboard';
import {
  adminClient,
  createTestRestaurant,
  fakeTurnstile,
  fillSignupIdentity,
  makeJpeg,
  TEST_PASSWORD,
  uniqueIdentity,
} from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

// One free trial per restaurant, and the photo of its front (docs/DECISIONS.md
// P11-10 to P11-14): a restaurant that already has an account is told so before
// any code is sent, the photo is needed, and the platform admin sees the photo
// and the restaurants that may be the same one.

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

async function inbox(page: Page, to: string) {
  const response = await page.request.get(`http://127.0.0.1:3190/resend/inbox?to=${to}`);
  return ((await response.json()) as { emails: unknown[] }).emails;
}

/** Everything but the one-trial details, by field name (English and Hindi). */
async function fillBasics(form: Locator, email: string, phone: string) {
  await form.locator('[name="restaurantName"]').fill(`Second Try ${unique()}`);
  await form.locator('[name="city"]').fill('Pune');
  await form.locator('[name="ownerName"]').fill('Asha Rao');
  await form.locator('[name="email"]').fill(email);
  await form.locator('[name="phone"]').fill(phone);
  await form.locator('[name="terms"]').check();
}

test('a restaurant whose licence already has an account is told before any code is sent', async ({
  page,
}) => {
  await fakeTurnstile(page.context());
  const taken = uniqueIdentity();
  const existing = await createTestRestaurant({ prefix: 'taken' });
  await adminClient()
    .from('restaurants')
    .update({ fssai_license: taken.fssai })
    .eq('id', existing.restaurantId)
    .throwOnError();

  await page.goto('/signup');
  const form = page.getByRole('form', { name: 'Start your free trial' });
  const email = `taken-${unique()}@e2e.test`;
  await fillBasics(form, email, uniqueIdentity().phone);
  await fillSignupIdentity(page, form, taken.fssai);
  await form.getByRole('button', { name: 'Email me a code' }).click();

  const alert = form.getByRole('alert');
  await expect(alert).toHaveText(
    'This restaurant already has a MenuMesh account. Log in, or contact us if that isn’t right.',
  );
  await expect(alert.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
  await expect(alert.getByRole('link', { name: 'contact us' })).toHaveAttribute('href', '/contact');
  await expect(page).toHaveURL(/\/signup$/);
  expect(await inbox(page, email)).toEqual([]);
});

test('in Hindi, a mobile that already has an account is refused the same way', async ({ page }) => {
  await fakeTurnstile(page.context());
  const taken = uniqueIdentity();
  const existing = await createTestRestaurant({ prefix: 'taken-hi' });
  await adminClient()
    .from('restaurants')
    .update({ phone: `+91 ${taken.phone}` })
    .eq('id', existing.restaurantId)
    .throwOnError();

  await page.goto('/hi/signup');
  const form = page.getByRole('main').locator('form');
  const email = `taken-hi-${unique()}@e2e.test`;
  // The mobile typed with a leading 0 is still the same mobile.
  await fillBasics(form, email, `0${taken.phone}`);
  await fillSignupIdentity(page, form, uniqueIdentity().fssai);
  await form.locator('button[type="submit"]').click();

  const alert = form.getByRole('alert');
  await expect(alert).toContainText('इस रेस्टोरेंट का MenuMesh अकाउंट पहले से बना हुआ है।');
  await expect(alert.getByRole('link', { name: 'हमसे संपर्क करें' })).toHaveAttribute(
    'href',
    '/hi/contact',
  );
  expect(await inbox(page, email)).toEqual([]);
});

test('the photo of the front is needed, and a tiny one is refused in the browser', async ({
  page,
}) => {
  await fakeTurnstile(page.context());
  await page.goto('/signup');
  const form = page.getByRole('form', { name: 'Start your free trial' });
  const identity = uniqueIdentity();
  await fillBasics(form, `photo-${unique()}@e2e.test`, identity.phone);
  await form.locator('[name="addressLine"]').fill('12 MG Road');
  await form.locator('[name="pincode"]').fill('411001');
  await form.locator('[name="fssaiLicense"]').fill(identity.fssai);
  await form.getByRole('button', { name: 'Email me a code' }).click();

  const choose = form.getByRole('button', { name: 'Take or choose a photo' });
  await expect(form.getByText('Add a photo of your restaurant’s front.')).toBeVisible();
  await expect(choose).toBeFocused();

  await form.locator('input[type="file"]').setInputFiles({
    name: 'tiny.jpg',
    mimeType: 'image/jpeg',
    buffer: await makeJpeg(page, 400, 300),
  });
  await expect(
    form.getByText('This photo is too small. Use one at least 800 pixels wide.'),
  ).toBeVisible();
  await expect(form.getByRole('img')).toHaveCount(0);
});

test('the platform admin sees the storefront photo and the restaurants that may be the same', async ({
  page,
}) => {
  const admin = adminClient();
  // A pincode of this run's own, so earlier runs' restaurants don't crowd the list.
  const pincode = String(100000 + Math.floor(Math.random() * 899999));
  const neighbour = await createTestRestaurant({ prefix: 'nbr' });
  await admin
    .from('restaurants')
    .update({ pincode })
    .eq('id', neighbour.restaurantId)
    .throwOnError();

  // A restaurant as the website's signup makes it.
  const path = `signups/${randomUUID()}.jpg`;
  const upload = await admin.storage
    .from('storefront-photos')
    .upload(path, await makeJpeg(page, 1200, 900), { contentType: 'image/jpeg' });
  if (upload.error) throw upload.error;
  const identity = uniqueIdentity();
  const name = `Self Signup ${unique()}`;
  const slug = `self-${unique()}`.slice(0, 32);
  const created = await onboardRestaurant(admin, {
    name,
    slug,
    ownerName: 'Test Owner',
    ownerUsername: 'owner',
    ownerPassword: TEST_PASSWORD,
    ownerEmail: `${slug}@e2e.test`,
    phone: `+91 ${identity.phone}`,
    addressLine: '5 FC Road',
    pincode,
    staffEmailDomain: process.env.STAFF_EMAIL_DOMAIN || 'tableorder.test',
    selfSignup: { fssaiLicense: identity.fssai, gstin: null, storefrontPhotoPath: path },
  });

  await logInAsPlatformAdmin(page, await createPlatformAdmin('review'));
  await page.goto(`/super/restaurants/${created.restaurantId}`);
  const photo = page
    .getByRole('region', { name: 'Storefront photo' })
    .getByRole('img', { name: `Front of ${name}` });
  await expect(photo).toBeVisible();
  await expect
    .poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect(page.getByRole('region', { name: 'Profile' })).toContainText(identity.fssai);

  const duplicates = page.getByRole('region', { name: 'Possible duplicates' });
  await expect(duplicates.getByRole('link', { name: neighbour.name })).toBeVisible();
  await expect(duplicates).toContainText(`${neighbour.slug}: Same pincode`);

  // The list marks it for a look.
  await page.goto(`/super/restaurants?q=${slug}`);
  await expect(
    page.locator(`tr[data-slug="${slug}"]`).getByText('Review', { exact: true }),
  ).toBeVisible();
});
