import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${PORT}`;
const isCI = Boolean(process.env.CI);
const MOCK_VISION_PORT = 3190;

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
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      // The customer panel is mobile-first (spec §13.1): it runs on the phone only.
      testIgnore: /customer-.*\.spec\.ts/,
    },
    // Customers use phones; Pixel keeps the run on Chromium only. The admin
    // panel is desktop-first (spec §13.3): only its navigation runs on mobile.
    // Live board specs open their own phone for the customer.
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      testIgnore: [
        /admin-(menu|tables|staff-waiters|settings|read-only)\.spec\.ts/,
        /(live-orders|staff-board|billing|reports|super-admin|menu-import)\.spec\.ts/,
      ],
    },
  ],
  webServer: [
    // A stand-in menu reader for photo imports (tests/e2e/mock-vision-server.mjs).
    {
      command: `node tests/e2e/mock-vision-server.mjs`,
      url: `http://127.0.0.1:${MOCK_VISION_PORT}/health`,
      env: { MOCK_VISION_PORT: String(MOCK_VISION_PORT) },
      reuseExistingServer: !isCI,
    },
    {
      command: isCI ? `pnpm start --port ${PORT}` : `pnpm build && pnpm start --port ${PORT}`,
      url: `${baseURL}/api/health`,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      // The server reads these at run time, so the build doesn't need them. A
      // reused dev server lacks them: the photo import tests then skip.
      env: {
        MENU_IMPORT_API_KEY: 'e2e-menu-reader-key',
        MENU_IMPORT_BASE_URL: `http://127.0.0.1:${MOCK_VISION_PORT}/v1`,
        MENU_IMPORT_FALLBACK_API_KEY: '',
        CRON_SECRET: 'e2e-cron-secret',
      },
    },
  ],
});
