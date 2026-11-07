import 'server-only';

import { z } from 'zod';

import { emptyToUndefined, formatIssues, optionalString } from './env';

/**
 * Server-only environment variables. Only what the built phases need is
 * required; the rest become required in the phase that uses them (see .env.example).
 */

const positiveInt = (fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(fallback));
const stringWithDefault = (fallback: string) =>
  z.preprocess(emptyToUndefined, z.string().min(1).default(fallback));
const urlWithDefault = (fallback: string) =>
  z.preprocess(emptyToUndefined, z.url({ protocol: /^https?$/ }).default(fallback));

const serverSchema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1),
  // Where the server reaches Supabase when that isn't the public address: the gateway inside
  // the VPS's own network (docs/DECISIONS.md VPS-20). Empty = NEXT_PUBLIC_SUPABASE_URL.
  SUPABASE_INTERNAL_URL: z.preprocess(emptyToUndefined, z.url({ protocol: /^https?$/ }).optional()),
  // Domain part of synthetic staff logins: <username>@<slug>.staff.<domain> (spec §9.5).
  STAFF_EMAIL_DOMAIN: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
        'must be a domain',
      )
      .default('tableorder.test'),
  ),
  // Signs the customer device cookie `cid` (spec §9.2).
  CUSTOMER_COOKIE_SECRET: z.preprocess(emptyToUndefined, z.string().min(32)),
  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,
  // Razorpay's REST API; tests point it at a local mock (docs/DECISIONS.md P8-1).
  RAZORPAY_API_BASE_URL: urlWithDefault('https://api.razorpay.com/v1'),
  CRON_SECRET: optionalString,
  // Menu photo import (docs/DECISIONS.md P7-12): any OpenAI-compatible
  // /chat/completions API; the fallback takes a page when the first fails.
  MENU_IMPORT_API_KEY: optionalString,
  MENU_IMPORT_BASE_URL: urlWithDefault('https://api.commandcode.ai/provider/v1'),
  MENU_IMPORT_MODEL: stringWithDefault('google/gemini-3.8-flash'),
  MENU_IMPORT_FALLBACK_API_KEY: optionalString,
  MENU_IMPORT_FALLBACK_BASE_URL: urlWithDefault('https://openrouter.ai/api/v1'),
  MENU_IMPORT_FALLBACK_MODEL: stringWithDefault('google/gemini-3.8-flash'),
  // Rupees per US dollar, for the cost of each import (P7-13).
  MENU_IMPORT_USD_INR: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(96)),
  RESEND_API_KEY: optionalString,
  EMAIL_FROM: optionalString,
  // Resend's REST API; tests point it at a local mock (docs/DECISIONS.md P8-12).
  RESEND_API_URL: urlWithDefault('https://api.resend.com'),
  // Signs Resend's bounce and complaint webhook (docs/DECISIONS.md SA-88).
  RESEND_WEBHOOK_SECRET: optionalString,
  // Sentry's issues for /super/system (SA-89): a read-only token (event:read),
  // apart from the build's SENTRY_AUTH_TOKEN. Tests point the API at a mock.
  SENTRY_READ_TOKEN: optionalString,
  SENTRY_ORG: optionalString,
  SENTRY_PROJECT: optionalString,
  SENTRY_API_URL: urlWithDefault('https://sentry.io/api/0'),
  // Whose /api/health versions /super/system shows (SA-92).
  PRODUCTION_APP_URL: urlWithDefault('https://menumesh.in'),
  STAGING_APP_URL: urlWithDefault('https://staging.menumesh.in'),
  // Cloudflare Turnstile on the website's forms (docs/DECISIONS.md W-6). The
  // forms are off without both keys, except under `next dev` (test keys).
  TURNSTILE_SITE_KEY: optionalString,
  TURNSTILE_SECRET_KEY: optionalString,
  // Siteverify's address; tests point it at a local mock.
  TURNSTILE_VERIFY_URL: urlWithDefault('https://challenges.cloudflare.com/turnstile/v0/siteverify'),
  PLATFORM_TRIAL_DAYS: positiveInt(14),
  PLATFORM_GRACE_DAYS: positiveInt(7),
});

export type ServerEnv = z.infer<typeof serverSchema>;

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverSchema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid server environment variables:\n${formatIssues(result.error)}\n` +
        'Copy .env.example to .env.local and fill in the missing values.',
    );
  }
  return result.data;
}

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
