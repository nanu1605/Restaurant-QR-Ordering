import 'server-only';

import { getServerEnv } from '@/lib/env.server';

/**
 * Cloudflare Turnstile, the bot check on the website's forms
 * (docs/DECISIONS.md W-6). The browser widget gives a one-use token; the
 * server checks it with siteverify before acting on the form.
 */

export type TurnstileConfig = {
  siteKey: string;
  secretKey: string;
  verifyUrl: string;
  fetchImpl?: typeof fetch;
};

/** Cloudflare's always-pass test keys, so the forms work under `next dev`. */
const DEV_KEYS = {
  siteKey: '1x00000000000000000000AA',
  secretKey: '1x0000000000000000000000000000000AA',
};

/** The keys, or null when the forms should stay off. */
export function turnstileConfig(): TurnstileConfig | null {
  const env = getServerEnv();
  const verifyUrl = env.TURNSTILE_VERIFY_URL;
  if (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) {
    return { siteKey: env.TURNSTILE_SITE_KEY, secretKey: env.TURNSTILE_SECRET_KEY, verifyUrl };
  }
  return process.env.NODE_ENV === 'development' ? { ...DEV_KEYS, verifyUrl } : null;
}

/** True only when Cloudflare confirms the token; any failure refuses (fails closed). */
export async function verifyTurnstile(
  config: TurnstileConfig,
  token: string,
  remoteIp: string | null,
): Promise<boolean> {
  // Tokens are at most 2048 characters (Cloudflare's siteverify docs).
  if (token.length === 0 || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: config.secretKey, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);
  try {
    const response = await (config.fetchImpl ?? fetch)(config.verifyUrl, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error('[turnstile] siteverify answered', response.status);
      return false;
    }
    const result = (await response.json()) as { success?: unknown; 'error-codes'?: unknown };
    if (result.success !== true) console.warn('[turnstile] token refused:', result['error-codes']);
    return result.success === true;
  } catch (error) {
    console.error('[turnstile] siteverify failed:', error);
    return false;
  }
}
