import { expect, type Page, test } from '@playwright/test';

// Search engines and link previews (docs/DECISIONS.md W-12).

type Node = {
  '@type': string;
  mainEntity?: { name: string }[];
  offers?: { name: string; price: string }[];
};

async function jsonLd(page: Page): Promise<Node[]> {
  const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
  return scripts.flatMap((text) => JSON.parse(text)['@graph'] as Node[]);
}

const meta = (page: Page, key: string) =>
  page.locator(`meta[property="${key}"], meta[name="${key}"]`).first().getAttribute('content');

test('robots.txt keeps the panels out and points to the sitemap', async ({ request }) => {
  const robots = await (await request.get('/robots.txt')).text();
  for (const path of [
    '/admin',
    '/staff',
    '/super',
    '/api/',
    '/signup/verify',
    '/hi/signup/verify',
  ]) {
    expect(robots).toContain(`Disallow: ${path}`);
  }
  const sitemapUrl = /Sitemap: (\S+)/.exec(robots)?.[1];
  expect(sitemapUrl).toMatch(/\/sitemap\.xml$/);

  const sitemap = await (await request.get('/sitemap.xml')).text();
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  expect(urls.map((url) => new URL(url!).pathname)).toEqual(
    expect.arrayContaining(['/', '/features', '/pricing', '/demo', '/contact', '/privacy']),
  );
  // Every URL is on the same site as the sitemap itself.
  for (const url of urls) expect(new URL(url!).origin).toBe(new URL(sitemapUrl!).origin);
});

test('the sitemap pairs each page with its Hindi twin', async ({ request }) => {
  const sitemap = await (await request.get('/sitemap.xml')).text();
  const entries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => match[1]!);
  const path = (url: string) => new URL(url).pathname;
  const locs = entries.map((entry) => path(/<loc>([^<]+)<\/loc>/.exec(entry)![1]!));
  expect(locs).toEqual(
    expect.arrayContaining(['/hi', '/hi/features', '/hi/pricing', '/hi/demo', '/hi/contact']),
  );
  // The policies are English only.
  expect(locs).not.toContain('/hi/terms');

  const hindiPricing = entries[locs.indexOf('/hi/pricing')]!;
  const alternates = Object.fromEntries(
    [
      ...hindiPricing.matchAll(/<xhtml:link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g),
    ].map((match) => [match[1], path(match[2]!)]),
  );
  expect(alternates).toEqual({
    'en-IN': '/pricing',
    'hi-IN': '/hi/pricing',
    'x-default': '/pricing',
  });
});

test('a Hindi page and its English twin point to each other', async ({ page }) => {
  const href = async (selector: string) =>
    new URL((await page.locator(selector).getAttribute('href'))!).pathname;
  const languages = async () => ({
    'en-IN': await href('link[rel="alternate"][hreflang="en-IN"]'),
    'hi-IN': await href('link[rel="alternate"][hreflang="hi-IN"]'),
    'x-default': await href('link[rel="alternate"][hreflang="x-default"]'),
  });
  const twins = { 'en-IN': '/pricing', 'hi-IN': '/hi/pricing', 'x-default': '/pricing' };

  await page.goto('/hi/pricing');
  expect(await href('link[rel="canonical"]')).toBe('/hi/pricing');
  expect(await languages()).toEqual(twins);
  expect(await meta(page, 'og:locale')).toBe('hi_IN');

  await page.goto('/pricing');
  expect(await href('link[rel="canonical"]')).toBe('/pricing');
  expect(await languages()).toEqual(twins);
  expect(await meta(page, 'og:locale')).toBe('en_IN');
});

test('hosts other than menumesh.in tell search engines not to index', async ({ request }) => {
  const response = await request.get('/');
  expect(response.headers()['x-robots-tag']).toBe('noindex');
});

test('the home page has a canonical, a link preview and structured data', async ({ page }) => {
  await page.goto('/');
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  expect(new URL(canonical!).pathname).toBe('/');
  expect(await meta(page, 'og:title')).toBe(await page.title());
  expect(await meta(page, 'twitter:card')).toBe('summary_large_image');

  const image = await meta(page, 'og:image');
  const preview = await page.request.get(new URL(image!).pathname + new URL(image!).search);
  expect(preview.headers()['content-type']).toBe('image/png');

  const nodes = await jsonLd(page);
  expect(nodes.map((node) => node['@type'])).toEqual(['Organization', 'WebSite', 'FAQPage']);
  // The same questions the page shows.
  await expect(page.locator('#faq details summary')).toHaveText(
    nodes[2]!.mainEntity!.map((question) => question.name),
  );
});

test('the pricing page describes each plan at the prices it shows', async ({ page }) => {
  await page.goto('/pricing');
  const [app] = (await jsonLd(page)).filter((node) => node['@type'] === 'SoftwareApplication');
  const offers = app!.offers!;
  expect(offers.length).toBeGreaterThan(0);
  const text = await page.getByRole('main').innerText();
  for (const offer of offers.filter((offer) => offer.name.endsWith(', monthly'))) {
    expect(text).toContain(offer.name.replace(', monthly', ''));
    const rupees = Number(offer.price).toLocaleString('en-IN');
    expect(text, offer.name).toContain(`₹${rupees}`);
  }
});

test('links with a chosen plan keep the plain page as canonical', async ({ page }) => {
  await page.goto('/contact?plan=growth');
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  expect(new URL(canonical!).pathname).toBe('/contact');
  expect(new URL(canonical!).search).toBe('');
});

test('an address that doesn’t exist gets the branded not-found page', async ({ page }) => {
  const response = await page.goto('/no-such-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute(
    'href',
    '/',
  );
});
