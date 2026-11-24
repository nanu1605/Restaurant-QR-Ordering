import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
} from '@playwright/test';
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
/** Any Hindi letter: Hindi pages are checked by script, so edits to their copy don't break a run. */
export const DEVANAGARI = /[\u0900-\u097F]/;

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

/**
 * Stands in for Cloudflare's Turnstile script (docs/DECISIONS.md W-6), so the
 * tests never reach Cloudflare: the "widget" passes at once with the dummy
 * token that the siteverify mock accepts.
 */
export async function fakeTurnstile(context: BrowserContext) {
  await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.turnstile = {
        render(container, options) {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = 'cf-turnstile-response';
          input.value = 'XXXX.DUMMY.TOKEN.XXXX';
          // Takes the real widget's room, so layout tests see it.
          const box = document.createElement('div');
          box.style.cssText = options.size === 'compact' ? 'width:150px;height:140px' : 'width:300px;height:65px';
          container.append(input, box);
          setTimeout(() => options.callback(input.value), 50);
          return 'e2e-widget';
        },
        remove() {},
      };`,
    }),
  );
}

export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('E2E needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY');
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** What the scheduler sends the cron routes; playwright.config.ts gives the server this secret. */
export const CRON_HEADERS = { Authorization: 'Bearer e2e-cron-secret' };

/**
 * One tick of the minute job (docs/DECISIONS.md VPS-29), kept to one kind of job: a tick works
 * the whole platform, so always name the kind. The route answers at once and the work runs after
 * the answer, so poll the database or the page for what it did. Answers 401 when the running
 * server has no CRON_SECRET for E2E.
 */
export function runJobs(
  request: APIRequestContext,
  kind: 'data_exports' | 'hindi_names' | 'announcement_emails',
) {
  return request.get(`/api/cron/jobs?kinds=${kind}`, { headers: CRON_HEADERS });
}

/**
 * A fresh restaurant per test (unique restaurant code), so tests never depend
 * on each other or on the demo seed (docs/DECISIONS.md P2-17).
 */
export async function createTestRestaurant({
  prefix = 'e2e',
  plan = 'growth',
  cuisine = 'north_indian',
  ownerEmail,
}: { prefix?: string; plan?: string; cuisine?: CuisineSet; ownerEmail?: string } = {}) {
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const slug = `${prefix}-${unique}`.slice(0, 32);
  const result = await onboardRestaurant(adminClient(), {
    name: `E2E ${prefix} ${unique}`,
    slug,
    ownerName: 'Test Owner',
    ownerUsername: 'owner',
    ownerPassword: TEST_PASSWORD,
    ownerEmail,
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

/** A JPEG made in the page: noise reads as a menu to the stand-in reader, white as blank. */
export async function makeJpeg(page: Page, width: number, height: number, blank = false) {
  const base64 = await page.evaluate(
    ({ width, height, blank }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      if (blank) {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
      } else {
        const image = context.createImageData(width, height);
        for (let i = 0; i < image.data.length; i += 4) {
          const value = (i * 2654435761) % 256;
          image.data[i] = value;
          image.data[i + 1] = (value * 7) % 256;
          image.data[i + 2] = (value * 13) % 256;
          image.data[i + 3] = 255;
        }
        context.putImageData(image, 0, 0);
      }
      return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
    },
    { width, height, blank },
  );
  return Buffer.from(base64, 'base64');
}

/** A mobile and an FSSAI licence no other run uses (one trial per restaurant, P11-10). */
export function uniqueIdentity() {
  const digits = () => String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const now = String(Date.now());
  return { phone: `9${now.slice(-6)}${digits()}`, fssai: `3${now.slice(-10)}${digits()}` };
}

/**
 * The signup's one-trial details (P11-10 to P11-12), by field name so it works in English and
 * Hindi: the address, pincode and licence, and a photo of the front, prepared in the page.
 */
export async function fillSignupIdentity(page: Page, form: Locator, fssai: string) {
  await form.locator('[name="addressLine"]').fill('12 MG Road');
  await form.locator('[name="pincode"]').fill('411001');
  await form.locator('[name="fssaiLicense"]').fill(fssai);
  await form.locator('input[type="file"]').setInputFiles({
    name: 'front.jpg',
    mimeType: 'image/jpeg',
    buffer: await makeJpeg(page, 1200, 900),
  });
  await expect(form.getByRole('img')).toBeVisible();
}
