import { defineConfig, devices } from '@playwright/test';

/**
 * The smoke tests against a deployed site (docs/DECISIONS.md P10-7):
 * SMOKE_URL=https://staging.menumesh.in pnpm smoke
 */
const baseURL = process.env.SMOKE_URL;
if (!baseURL)
  throw new Error('Set SMOKE_URL to the site to check, e.g. https://staging.menumesh.in');

export default defineConfig({
  testDir: './tests/smoke',
  // A deploy that has just gone live can take a moment to warm up.
  retries: 2,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: { ...devices['Desktop Chrome'], baseURL },
});
