import 'server-only';

import { cookies } from 'next/headers';

import { APP_NAME } from '@/lib/config';
import { emailConfig, escapeHtml } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';
import { turnstileConfig } from '@/lib/turnstile';

import { SITE, type SiteLang } from './content';
import { fill } from './i18n';

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
export function signupCodeEmail(code: string, lang: SiteLang = 'en') {
  const t = SITE[lang].emails.code;
  const lines = t.lines.map((line) => fill(line, { app: APP_NAME, code }));
  return {
    subject: fill(t.subject, { app: APP_NAME, code }),
    text: lines.join('\n\n'),
    html: paragraphs(lines).replace(
      escapeHtml(code),
      `<strong style="font-size:24px;letter-spacing:4px">${escapeHtml(code)}</strong>`,
    ),
  };
}

/** Where each of the welcome email's first steps leads, by position. */
const STEP_PATHS = ['/admin/menu', '/admin/tables', '/admin/staff', '/admin/subscription'];

/** The welcome email: how to log in, the code staff need, and the first steps. */
export function welcomeEmail(input: {
  ownerName: string;
  restaurantName: string;
  slug: string;
  appUrl: string;
  lang?: SiteLang;
}) {
  const t = SITE[input.lang ?? 'en'].emails.welcome;
  const app = input.appUrl.replace(/\/+$/, '');
  const steps = t.steps.map((step, index): [string, string] => [
    step,
    `${app}${STEP_PATHS[index]}`,
  ]);
  const intro = t.intro.map((line) =>
    fill(line, {
      owner: input.ownerName,
      restaurant: input.restaurantName,
      app: APP_NAME,
      url: `${app}/login`,
      slug: input.slug,
    }),
  );
  return {
    subject: fill(t.subject, { app: APP_NAME, restaurant: input.restaurantName }),
    text: [
      ...intro,
      [t.firstSteps, ...steps.map(([step, url], index) => `${index + 1}. ${step}: ${url}`)].join(
        '\n',
      ),
    ].join('\n\n'),
    html: [
      paragraphs(intro),
      `<p>${escapeHtml(t.firstSteps)}</p>`,
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
