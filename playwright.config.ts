import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${PORT}`;
const isCI = Boolean(process.env.CI);
const MOCK_APIS_PORT = 3190;

/**
 * E2E runs against a production build (`next start`) and the local Supabase
 * stack. CI builds in an earlier step, so only the server is started there.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    // The read-only checks run after each deploy (playwright.smoke.config.ts); here they
    // check the local build.
    { name: 'smoke', testDir: './tests/smoke', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      // The customer panel is mobile-first (spec §13.1): it runs on the phone only.
      testIgnore: /customer-.*\.spec\.ts/,
    },
    // The public website and the admin menu sheet are checked on a tablet too
    // (docs/DECISIONS.md W-4, B-6).
    {
      name: 'tablet',
      use: { ...devices['iPad Mini'], browserName: 'chromium' },
      testMatch: /(site|site-demo|admin-nav)\.spec\.ts/,
    },
    // Customers use phones; Pixel keeps the run on Chromium only. The admin
    // panel is desktop-first (spec §13.3): only its navigation runs on mobile.
    // Live board specs open their own phone for the customer.
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      testIgnore: [
        /admin-(menu|tables|staff-waiters|settings|read-only)\.spec\.ts/,
        /(live-orders|offline-queue|staff-board|billing|reports|super-admin|menu-import|subscription|razorpay-admin|table-service|menu-addons|security-headers|site-leads|contrast|panels-responsive)\.spec\.ts/,
      ],
    },
  ],
  webServer: [
    // Stand-ins for the menu reader, Razorpay and Resend (tests/e2e/mock-apis.mjs).
    {
      command: `node tests/e2e/mock-apis.mjs`,
      url: `http://127.0.0.1:${MOCK_APIS_PORT}/health`,
      env: { MOCK_APIS_PORT: String(MOCK_APIS_PORT) },
      reuseExistingServer: !isCI,
    },
    {
      command: isCI ? `pnpm start --port ${PORT}` : `pnpm build && pnpm start --port ${PORT}`,
      url: `${baseURL}/api/health`,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      // The server reads these at run time, so the build doesn't need them. A
      // reused dev server lacks them: the photo import, payment and email tests then skip.
      env: {
        MENU_IMPORT_API_KEY: 'e2e-menu-reader-key',
        MENU_IMPORT_BASE_URL: `http://127.0.0.1:${MOCK_APIS_PORT}/v1`,
        MENU_IMPORT_FALLBACK_API_KEY: '',
        CRON_SECRET: 'e2e-cron-secret',
        RAZORPAY_KEY_ID: 'rzp_test_e2e',
        RAZORPAY_KEY_SECRET: 'e2e-razorpay-secret',
        RAZORPAY_WEBHOOK_SECRET: 'e2e-webhook-secret',
        RAZORPAY_API_BASE_URL: `http://127.0.0.1:${MOCK_APIS_PORT}/razorpay/v1`,
        RESEND_API_KEY: 're_e2e_resend_key',
        RESEND_API_URL: `http://127.0.0.1:${MOCK_APIS_PORT}/resend`,
        EMAIL_FROM: 'MenuMesh <billing@menumesh.test>',
        // Cloudflare's always-pass test keys; the browser widget is faked (fakeTurnstile).
        TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        TURNSTILE_VERIFY_URL: `http://127.0.0.1:${MOCK_APIS_PORT}/turnstile/siteverify`,
      },
    },
  ],
});
