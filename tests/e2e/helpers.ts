import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { type BrowserContext, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import type { CuisineSet } from '../../src/features/menu/default-categories';
import { onboardRestaurant } from '../../src/features/platform/onboard';
import type { Database } from '../../src/types/database';

// Local Supabase keys; CI writes the same file before the E2E step.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

/** Seeded demo accounts (supabase/seed.sql). Never present outside local/CI. */
export const DEMO_PASSWORD = 'Password123!';
/** Password for owners and staff the tests create. */
export const TEST_PASSWORD = 'e2e-Password-1';

/**
 * Records every Content-Security-Policy violation in the context's pages, from
 * their next load on (docs/DECISIONS.md P9-9).
 */
export async function watchCspViolations(context: BrowserContext) {
  const violations: string[] = [];
  await context.exposeBinding('e2eCspViolation', ({ page }, violation: string) => {
    violations.push(`${new URL(page.url()).pathname}: ${violation}`);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { e2eCspViolation: (v: string) => void })
        .e2eCspViolation;
      void report(`${event.effectiveDirective} blocked ${event.blockedURI || 'inline'}`);
    });
  });
  return violations;
}

export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('E2E needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY');
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * A fresh restaurant per test (unique restaurant code), so tests never depend
 * on each other or on the demo seed (docs/DECISIONS.md P2-17).
 */
export async function createTestRestaurant({
  prefix = 'e2e',
  plan = 'growth',
  cuisine = 'north_indian',
}: { prefix?: string; plan?: string; cuisine?: CuisineSet } = {}) {
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const slug = `${prefix}-${unique}`.slice(0, 32);
  const result = await onboardRestaurant(adminClient(), {
    name: `E2E ${prefix} ${unique}`,
    slug,
    ownerName: 'Test Owner',
    ownerUsername: 'owner',
    ownerPassword: TEST_PASSWORD,
    plan,
    cuisine,
    staffEmailDomain: process.env.STAFF_EMAIL_DOMAIN || 'tableorder.test',
  });
  return { ...result, name: `E2E ${prefix} ${unique}`, password: TEST_PASSWORD };
}

// Login tab panels are labelled by their tab; scope controls to the one in use
// (the old panel stays mounted briefly while switching).
const panel = (page: Page, tab: 'Restaurant code' | 'Email') =>
  page.getByRole('tabpanel', { name: tab });

export async function logInWithCode(page: Page, code: string, username: string, password: string) {
  const form = panel(page, 'Restaurant code');
  await form.getByRole('textbox', { name: 'Restaurant code', exact: true }).fill(code);
  await form.getByRole('textbox', { name: 'Username', exact: true }).fill(username);
  await form.getByLabel('Password', { exact: true }).fill(password);
  await form.getByRole('button', { name: 'Log in' }).click();
}

export async function logInWithEmail(page: Page, email: string, password: string) {
  await page.getByRole('tab', { name: 'Email' }).click();
  const form = panel(page, 'Email');
  await form.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await form.getByLabel('Password', { exact: true }).fill(password);
  await form.getByRole('button', { name: 'Log in' }).click();
}

/** Opens /login, signs the owner of a test restaurant in and waits for the admin panel. */
export async function logInAsOwner(page: Page, restaurant: { slug: string; password: string }) {
  await page.goto('/login');
  await logInWithCode(page, restaurant.slug, 'owner', restaurant.password);
  await expect(page).toHaveURL(/\/admin$/);
}

/** A small valid PNG (solid colour), for image uploads. */
export function makePng(width = 64, height = 48, rgb: [number, number, number] = [200, 120, 40]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buffer: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
