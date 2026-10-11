import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { adminClient, DEVANAGARI, fakeTurnstile } from './helpers';

// The website in Hindi under /hi, with the policies in English only (docs/DECISIONS.md W-15).

/** The verify page shows while a signup waits for its code (startSignup). */
const PAGES = [
  '/hi',
  '/hi/features',
  '/hi/pricing',
  '/hi/demo',
  '/hi/contact',
  '/hi/signup',
  '/hi/signup/verify',
];

test.beforeEach(async ({ context }) => {
  await fakeTurnstile(context);
});

/** A signup waiting for its code, so /hi/signup/verify shows instead of sending to /hi/signup. */
async function startSignup(context: BrowserContext, baseURL: string) {
  const admin = adminClient();
  const { data } = await admin
    .from('site_signups')
    .insert({ email: `hindi-${Date.now()}@e2e.test`, details: {}, code_hash: '0'.repeat(64) })
    .select('id')
    .single()
    .throwOnError();
  await context.addCookies([{ name: 'mm_signup', value: data.id, url: baseURL }]);
  return () => admin.from('site_signups').delete().eq('id', data.id);
}

const LANGUAGE = /^(Language|भाषा)$/;

/** The footer's English / हिन्दी buttons (the phone menu has them too). */
const footerLanguages = (page: Page) =>
  page.getByRole('contentinfo').getByRole('group', { name: LANGUAGE });

/** Moves to the other language: the header's language menu from 1024px, the footer below. */
async function switchTo(page: Page, name: 'English' | 'हिन्दी') {
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    await page.getByRole('banner').getByRole('button', { name: LANGUAGE }).click();
    await page.getByRole('menuitemradio', { name, exact: true }).click();
  } else {
    await footerLanguages(page).getByRole('link', { name, exact: true }).click();
  }
}

test('every Hindi page is marked Hindi and has a Hindi heading', async ({
  page,
  context,
  baseURL,
}) => {
  const removeSignup = await startSignup(context, baseURL!);
  try {
    for (const path of PAGES) {
      await page.goto(path);
      expect(new URL(page.url()).pathname, path).toBe(path);
      await expect(page.locator('html'), path).toHaveAttribute('lang', 'hi');
      await expect(page.getByRole('heading', { level: 1 }), path).toContainText(DEVANAGARI);
    }
  } finally {
    await removeSignup();
  }
});

test('the switch leads to the same page in the other language and back', async ({ page }) => {
  await page.goto('/pricing');
  await switchTo(page, 'हिन्दी');
  await expect(page).toHaveURL(/\/hi\/pricing$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(DEVANAGARI);
  await expect(footerLanguages(page).locator('[aria-current="true"]')).toHaveText('हिन्दी');

  await switchTo(page, 'English');
  await expect(page).toHaveURL(/:\d+\/pricing$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(footerLanguages(page).locator('[aria-current="true"]')).toHaveText('English');
});

test('the switch keeps the chosen plan and the campaign tags', async ({ page }) => {
  // docs/DECISIONS.md W-17: a client-side move, so the visit's source carries over too.
  await page.goto('/contact?plan=growth&utm_source=newsletter');
  await switchTo(page, 'हिन्दी');
  await expect(page).toHaveURL(/\/hi\/contact\?plan=growth&utm_source=newsletter$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page.locator('select[name="planCode"]')).toHaveValue('growth');
});

test('the policies are English only: their switch leads to the Hindi home page', async ({
  page,
}) => {
  await page.goto('/terms');
  await switchTo(page, 'हिन्दी');
  await expect(page).toHaveURL(/\/hi$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');

  // The Hindi footer links to the English policy, which loads as an English page.
  const terms = page.getByRole('contentinfo').locator('a[href="/terms"]');
  await expect(terms).toHaveAttribute('hreflang', 'en');
  await expect(terms).toContainText(DEVANAGARI);
  await terms.click();
  await expect(page).toHaveURL(/:\d+\/terms$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1, name: 'Terms of service' })).toBeVisible();

  const response = await page.goto('/hi/terms');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('main')).toHaveAttribute('lang', 'en');
});

test('no Hindi page scrolls sideways, from 320px to 1024px', async ({ page, context, baseURL }) => {
  test.slow();
  const removeSignup = await startSignup(context, baseURL!);
  try {
    for (const width of [320, 380, 768, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of PAGES) {
        await page.goto(path);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(0);
      }
    }
  } finally {
    await removeSignup();
  }
});

test('an English page doesn’t download the Devanagari font for the switch', async ({ page }) => {
  // Noto Sans's devanagari face; Chrome writes U+0900-097F as U+900-97F.
  const devanagariFaces = () =>
    page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((face) => face.unicodeRange.includes('U+900-97F'))
        .map((face) => face.status);
    });

  await page.goto('/contact', { waitUntil: 'load' });
  await expect(page.getByRole('link', { name: 'हिन्दी', exact: true }).first()).toBeAttached();
  const faces = await devanagariFaces();
  expect(faces.length).toBeGreaterThan(0);
  expect(faces).not.toContain('loaded');
  expect(faces).not.toContain('loading');

  // A Hindi page does use it.
  await page.goto('/hi/contact', { waitUntil: 'load' });
  expect(await devanagariFaces()).toContain('loaded');
});
