import { expect, type Page, test } from '@playwright/test';

import { DEMO_PASSWORD, logInWithCode } from './helpers';

// "Install app" in the account menu (docs/DECISIONS.md B-7): the browser's own prompt, or
// Safari's Share → Add to Home Screen, and nothing once installed.

async function openAccountMenu(page: Page) {
  await page.goto('/login');
  await logInWithCode(page, 'demo', 'waiter1', DEMO_PASSWORD);
  await expect(page).toHaveURL(/\/staff$/);
  await page.getByRole('banner').getByRole('button', { name: 'Ravi Kumar' }).click();
  await expect(page.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
}

const installItem = (page: Page) => page.getByRole('menuitem', { name: 'Install app' });

test('the browser’s install prompt opens from the account menu', async ({ page }) => {
  await openAccountMenu(page);
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: () => {
        document.documentElement.dataset.prompted = 'yes';
        return Promise.resolve();
      },
    });
    window.dispatchEvent(event);
  });

  await installItem(page).click();
  await expect(page.locator('html')).toHaveAttribute('data-prompted', 'yes');
  // A prompt can only be shown once.
  await page.getByRole('banner').getByRole('button', { name: 'Ravi Kumar' }).click();
  await expect(page.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
  await expect(installItem(page)).toHaveCount(0);
});

test('Safari on an iPhone or iPad gets the Add to Home Screen steps', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: false }));
  await openAccountMenu(page);
  await installItem(page).click();
  await expect(
    page.getByText(
      /^To install, tap Share \(under ••• if you don’t see it\), then Add to Home Screen\.$/,
    ),
  ).toBeVisible();
});

test('the installed app doesn’t offer to install itself', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await openAccountMenu(page);
  await expect(installItem(page)).toHaveCount(0);
});

test('an app’s in-app browser, which can’t add to the Home Screen, gets no steps', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram',
  });
  const page = await context.newPage();
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: false }));
  await openAccountMenu(page);
  await expect(installItem(page)).toHaveCount(0);
  await context.close();
});

// The installed app's launch screen (docs/DECISIONS.md P11-4, P11-5).
test('a browser tab never shows the launch screen', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('.app-splash')).toBeHidden();
  await logInWithCode(page, 'demo', 'waiter1', DEMO_PASSWORD);
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.locator('.app-splash')).toBeHidden();
});

/**
 * As if opened from the home screen: Chromium can't emulate display-mode, so the stylesheets'
 * own "(display-mode: standalone)" rules are added again as they load, without that condition.
 */
function applyStandaloneRules() {
  document.addEventListener(
    'load',
    (event) => {
      const sheet = event.target instanceof HTMLLinkElement ? event.target.sheet : null;
      if (!sheet) return;
      for (const rule of [...sheet.cssRules]) {
        if (!(rule instanceof CSSMediaRule)) continue;
        if (!rule.conditionText.includes('display-mode: standalone')) continue;
        const always = rule.cssText.replace('(display-mode: standalone)', '(min-width: 0px)');
        sheet.insertRule(always, sheet.cssRules.length);
      }
    },
    true,
  );
}

/** Slow scripts keep the page loading long enough to see the screen. */
function slowScripts(page: Page) {
  return page.route(/\/_next\/static\/chunks\/.*\.js/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
}

test('the installed app shows the launch screen until the page has loaded', async ({ page }) => {
  await page.addInitScript(applyStandaloneRules);
  await page.addInitScript(() => {
    // When the page loaded, and what the screen looks like just after the zoom begins: still
    // showing, logo zooming.
    let loadedAt = 0;
    addEventListener('load', () => (loadedAt = performance.now()));
    new MutationObserver((_records, observer) => {
      const splash = document.querySelector('.app-splash');
      if (!splash?.hasAttribute('data-done')) return;
      observer.disconnect();
      const heldAfterLoad = performance.now() - loadedAt;
      setTimeout(() => {
        const logo = splash.querySelector('.app-splash-logo')!;
        Object.assign(window, {
          splashAfterLoad: {
            heldAfterLoad,
            opacity: Number(getComputedStyle(splash).opacity),
            zooming: logo
              .getAnimations()
              .some(
                (a) =>
                  a instanceof CSSAnimation &&
                  a.animationName === 'app-splash-zoom' &&
                  a.playState === 'running',
              ),
          },
        });
      }, 150);
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-done'] });
  });
  await slowScripts(page);

  await page.goto('/login', { waitUntil: 'commit' });
  const splash = page.locator('.app-splash');
  await expect(splash).toHaveCSS('position', 'fixed');
  await expect(splash).toBeVisible();
  await expect(splash).toContainText('Powered by Jainav Infotech Pvt Ltd');

  // Once the page has loaded, the logo zooms in while the screen is still showing, then the
  // screen goes.
  await expect(page.locator('html')).toHaveAttribute('data-launched', '', { timeout: 15_000 });
  await expect(splash).toBeHidden();
  const afterLoad = await page.evaluate(
    () =>
      (
        window as {
          splashAfterLoad?: { heldAfterLoad: number; opacity: number; zooming: boolean };
        }
      ).splashAfterLoad,
  );
  // It stays long enough to be seen after the page has loaded (P11-4), then zooms.
  expect(afterLoad?.heldAfterLoad).toBeGreaterThanOrEqual(650);
  expect(afterLoad?.zooming).toBe(true);
  expect(afterLoad?.opacity).toBeGreaterThan(0);

  // Moving around inside the app doesn't bring it back: the same document, still launched.
  await page.unrouteAll();
  await page.evaluate(() => Object.assign(window, { sameDocument: true }));
  await logInWithCode(page, 'demo', 'waiter1', DEMO_PASSWORD);
  await expect(page).toHaveURL(/\/staff$/);
  expect(await page.evaluate(() => 'sameDocument' in window)).toBe(true);
  expect(await page.locator('.app-splash').isVisible()).toBe(false);
});

test('installing from the website gives the same app, and any page shows the launch screen', async ({
  page,
  context,
}) => {
  // The website and the login page offer the app itself, which opens on /login (P9-6).
  for (const path of ['/', '/hi/pricing', '/login']) {
    await page.goto(path);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/app.webmanifest');
  }
  await page.goto('/');
  const cdp = await context.newCDPSession(page);
  expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);

  // A home screen app that opens on a website page, as Safari's does when added from it.
  await page.addInitScript(applyStandaloneRules);
  await slowScripts(page);
  await page.goto('/', { waitUntil: 'commit' });
  const splash = page.locator('.app-splash');
  await expect(splash).toBeVisible();
  await expect(splash).toContainText('Powered by Jainav Infotech Pvt Ltd');
  await expect(page.locator('html')).toHaveAttribute('data-launched', '', { timeout: 15_000 });
  await expect(splash).toBeHidden();
});

test('the launch screen is never printed', async ({ page }) => {
  // A bill's print page prints as soon as it opens, maybe in a new app window (P11-4).
  await page.emulateMedia({ media: 'print' });
  await page.addInitScript(applyStandaloneRules);
  await slowScripts(page);
  await page.goto('/login');
  await expect(page.locator('.app-splash')).toHaveCSS('display', 'none');
  // Hidden by print itself, not because the app has launched.
  await expect(page.locator('html')).not.toHaveAttribute('data-launched', '');
});
