import 'server-only';

import { cookies } from 'next/headers';

import { APP_NAME } from '@/lib/config';
import { emailConfig, escapeHtml } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';
import { turnstileConfig } from '@/lib/turnstile';

import { SITE, type SiteLang } from './content';

/**
 * The self-serve signup (docs/DECISIONS.md W-9): when it is open, and the
 * restaurant code and emails it makes.
 */

/** Signup needs the bot check and email (for the code); otherwise visitors book a demo. */
export function signupOpen(): boolean {
  return turnstileConfig() !== null && emailConfig() !== null;
}

/** The website's main call to action. */
export function siteCta(lang: SiteLang): { href: string; label: string } {
  const { cta } = SITE[lang];
  return signupOpen()
    ? { href: '/signup', label: cta.signup }
    : { href: '/contact', label: cta.demo };
}

/**
 * A restaurant code from its name ("Spice Route & Co." → "spice-route-and-co"),
 * with a suffix when the plain one is taken. Names without Latin letters get
 * "restaurant". Fits RESTAURANT_CODE_PATTERN.
 */
export function slugFromName(name: string, suffix?: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  const slug = base.length >= 3 ? base : 'restaurant';
  return suffix ? `${slug}-${suffix}` : slug;
}

const paragraphs = (lines: string[]) =>
  lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n');

/** The email with the 6-digit code. */
export function signupCodeEmail(code: string) {
  const lines = [
    `Your ${APP_NAME} code is ${code}.`,
    'Enter it on the sign-up page to create your restaurant. It works for 15 minutes.',
    `If you didn’t sign up for ${APP_NAME}, you can ignore this email.`,
  ];
  return {
    subject: `${code} is your ${APP_NAME} code`,
    text: lines.join('\n\n'),
    html: paragraphs(lines).replace(
      escapeHtml(code),
      `<strong style="font-size:24px;letter-spacing:4px">${escapeHtml(code)}</strong>`,
    ),
  };
}

/** The welcome email: how to log in, the code staff need, and the first steps. */
export function welcomeEmail(input: {
  ownerName: string;
  restaurantName: string;
  slug: string;
  appUrl: string;
}) {
  const app = input.appUrl.replace(/\/+$/, '');
  const steps: Array<[string, string]> = [
    ['Add your menu, or import it from a photo', `${app}/admin/menu`],
    ['Add your tables and print their QR codes', `${app}/admin/tables`],
    ['Give your staff their logins', `${app}/admin/staff`],
    ['Set up autopay before your free trial ends', `${app}/admin/subscription`],
  ];
  const intro = [
    `Hi ${input.ownerName},`,
    `${input.restaurantName} is ready on ${APP_NAME}.`,
    `Log in at ${app}/login with this email and your password.`,
    `Your restaurant code is ${input.slug}. Your staff need it, with their own username and password, to log in.`,
  ];
  return {
    subject: `Welcome to ${APP_NAME}, ${input.restaurantName}`,
    text: [
      ...intro,
      ['First steps:', ...steps.map(([step, url], index) => `${index + 1}. ${step}: ${url}`)].join(
        '\n',
      ),
    ].join('\n\n'),
    html: [
      paragraphs(intro),
      '<p>First steps:</p>',
      '<ol>',
      ...steps.map(
        ([step, url]) => `<li><a href="${escapeHtml(url)}">${escapeHtml(step)}</a></li>`,
      ),
      '</ol>',
    ].join('\n'),
  };
}

/** The signup in progress, between /signup and /signup/verify. */
const SIGNUP_COOKIE = 'mm_signup';

export async function setSignupCookie(id: string) {
  (await cookies()).set(SIGNUP_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: getPublicEnv().NEXT_PUBLIC_APP_URL.startsWith('https://'),
    path: '/signup',
    maxAge: 60 * 60,
  });
}

export async function clearSignupCookie() {
  (await cookies()).delete({ name: SIGNUP_COOKIE, path: '/signup' });
}

/** The signup id from the cookie, if it looks like one. */
export async function signupIdFromCookie(): Promise<string | null> {
  const id = (await cookies()).get(SIGNUP_COOKIE)?.value ?? '';
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
}
