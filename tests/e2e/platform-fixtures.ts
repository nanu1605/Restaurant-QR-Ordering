import { createHmac } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

import { adminClient, logInWithEmail, TEST_PASSWORD } from './helpers';

/**
 * Platform admins for E2E. Each test makes its own, because a platform admin's
 * authenticator is part of its state; the seeded super@local.test is left for
 * people to enrol by hand (docs/DECISIONS.md P7-2).
 */
export type PlatformAdmin = { email: string; userId: string; secret?: string };

export async function createPlatformAdmin(prefix = 'admin'): Promise<PlatformAdmin> {
  const admin = adminClient();
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `${prefix}-${unique}@platform.test`;
  const created = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  const userId = created.data.user.id;
  const inserted = await admin.from('platform_admins').insert({ user_id: userId });
  if (inserted.error) throw inserted.error;
  return { email, userId };
}

/** The current TOTP code for a base32 secret (RFC 6238: SHA-1, 30 s, 6 digits). */
export function totpCode(secret: string, at = Date.now()) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const value = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

function base32Decode(text: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error(`Not base32: ${char}`);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/**
 * Logs a platform admin in and passes the second factor: enrols an
 * authenticator on the first login (keeping the secret on `admin`), then
 * enters the current code. Ends on the super-admin Home.
 */
export async function logInAsPlatformAdmin(page: Page, admin: PlatformAdmin) {
  await page.goto('/login');
  await logInWithEmail(page, admin.email, TEST_PASSWORD);
  await expect(page).toHaveURL(/\/super\/mfa$/);

  const main = page.getByRole('main');
  if (!admin.secret) {
    await main.getByRole('button', { name: 'Set up authenticator app' }).click();
    admin.secret = (await main.getByTestId('totp-secret').textContent())?.trim() ?? '';
    expect(admin.secret).toMatch(/^[A-Z2-7]+=*$/);
  }
  await main.getByLabel('6-digit code').fill(totpCode(admin.secret));
  await main.getByRole('button', { name: 'Verify' }).click();
  try {
    await expect(page).toHaveURL(/\/super$/, { timeout: 10_000 });
  } catch {
    // Under load a code can run out on its way: try once more with the next one.
    await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
    await main.getByLabel('6-digit code').fill(totpCode(admin.secret));
    await main.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/super$/);
  }
}
