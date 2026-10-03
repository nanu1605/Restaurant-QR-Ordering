import { defineConfig, devices } from '@playwright/test';

/**
 * Screenshots for the website's features page (tests/site-shots,
 * docs/DECISIONS.md W-7), against a running local app: `pnpm site:shots`.
 */
export default defineConfig({
  testDir: './tests/site-shots',
  testMatch: /site-shots\.ts$/,
  workers: 1,
  reporter: 'list',
  use: { baseURL: process.env.SHOTS_BASE_URL ?? 'http://localhost:3000' },
  projects: [{ name: 'shots', use: { ...devices['Desktop Chrome'] } }],
});
