import 'server-only';

import { z } from 'zod';

import { emptyToUndefined, formatIssues, optionalString } from './env';

/**
 * Server-only environment variables. Only what Phase 0 needs is required;
 * the rest become required in the phase that uses them (see .env.example).
 */

const positiveInt = (fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(fallback));

const serverSchema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1),
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
  CUSTOMER_COOKIE_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,
  CRON_SECRET: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  MENU_IMPORT_MODEL: z.preprocess(emptyToUndefined, z.string().min(1).default('claude-sonnet-5')),
  RESEND_API_KEY: optionalString,
  EMAIL_FROM: optionalString,
  SENTRY_DSN: optionalString,
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
