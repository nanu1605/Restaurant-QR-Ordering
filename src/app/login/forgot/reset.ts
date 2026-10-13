import 'server-only';

import { cookies } from 'next/headers';

import { APP_NAME } from '@/lib/config';
import { escapeHtml } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';

/** "Forgot password" (docs/DECISIONS.md P11-6): the reset in progress, and its email. */

/** The reset in progress and the email it was asked for, between the two steps. */
const RESET_COOKIE = 'mm_reset';
const RESET_PATH = '/login';

type PendingReset = { id: string; email: string };

export async function setResetCookie(reset: PendingReset) {
  (await cookies()).set(RESET_COOKIE, JSON.stringify(reset), {
    httpOnly: true,
    sameSite: 'lax',
    secure: getPublicEnv().NEXT_PUBLIC_APP_URL.startsWith('https://'),
    path: RESET_PATH,
    maxAge: 30 * 60,
  });
}

export async function clearResetCookie() {
  (await cookies()).delete({ name: RESET_COOKIE, path: RESET_PATH });
}

/** The reset from the cookie, if it looks like one. */
export async function resetFromCookie(): Promise<PendingReset | null> {
  try {
    const value: unknown = JSON.parse((await cookies()).get(RESET_COOKIE)?.value ?? '');
    const { id, email } = (value ?? {}) as Partial<Record<keyof PendingReset, unknown>>;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return null;
    if (typeof email !== 'string' || email.length > 254) return null;
    return { id, email };
  } catch {
    return null;
  }
}

/** The email with the 6-digit code (English, like the login page). */
export function passwordResetEmail(code: string) {
  const lines = [
    `Use this code to set a new ${APP_NAME} password: ${code}`,
    'It works for 15 minutes.',
    'If you didn’t ask for this, ignore this email. Your password stays the same.',
  ];
  return {
    subject: `${code} is your ${APP_NAME} password reset code`,
    text: lines.join('\n\n'),
    html: lines
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('\n')
      .replace(
        escapeHtml(code),
        `<strong style="font-size:24px;letter-spacing:4px">${escapeHtml(code)}</strong>`,
      ),
  };
}
