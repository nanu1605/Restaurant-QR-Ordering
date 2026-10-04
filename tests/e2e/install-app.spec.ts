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
