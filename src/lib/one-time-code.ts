import 'server-only';

import { createHmac, randomInt } from 'node:crypto';

import { headers } from 'next/headers';

import { getServerEnv } from '@/lib/env.server';

/**
 * The 6-digit codes sent by email: the website's signup (docs/DECISIONS.md
 * W-9) and "Forgot password" (P11-6). Only a keyed hash is stored, and each
 * purpose hashes apart, so a code for one never fits the other.
 */

export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export const hashCode = (purpose: 'signup' | 'password-reset', code: string) =>
  createHmac('sha256', getServerEnv().CUSTOMER_COOKIE_SECRET)
    .update(`${purpose}-code:${code}`)
    .digest('hex');

/** The visitor's IP address as the host reports it, for rate limits. */
export async function clientIp(): Promise<string | null> {
  const requestHeaders = await headers();
  return (
    requestHeaders.get('x-real-ip') ??
    requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  );
}
