import { defineConfig, devices } from '@playwright/test';

/**
 * The smoke tests against a deployed site (docs/DECISIONS.md P10-7):
 * SMOKE_URL=https://staging.menumesh.in pnpm smoke
 */
const baseURL = process.env.SMOKE_URL;
if (!baseURL)
  throw new Error('Set SMOKE_URL to the site to check, e.g. https://staging.menumesh.in');

// Staging sits behind basic auth: SMOKE_BASIC_AUTH is "user:password",
// split at the first colon (the password may hold colons). Sent to this origin only, and always,
// since the site answers 401 before a browser would offer credentials. Production leaves it unset.
const basicAuth = process.env.SMOKE_BASIC_AUTH;
const colon = basicAuth ? basicAuth.indexOf(':') : -1;
if (basicAuth && colon < 1)
  throw new Error('SMOKE_BASIC_AUTH must be user:password (the user name cannot be empty)');
const httpCredentials = basicAuth
  ? {
      username: basicAuth.slice(0, colon),
      password: basicAuth.slice(colon + 1),
      origin: new URL(baseURL).origin,
      send: 'always' as const,
    }
  : undefined;

export default defineConfig({
  testDir: './tests/smoke',
  // A deploy that has just gone live can take a moment to warm up.
  retries: 2,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: { ...devices['Desktop Chrome'], baseURL, ...(httpCredentials && { httpCredentials }) },
});
