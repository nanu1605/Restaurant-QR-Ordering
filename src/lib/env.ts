import { z } from 'zod';

/**
 * Public environment variables (safe in the browser bundle).
 *
 * Next.js only inlines `NEXT_PUBLIC_*` values that are referenced literally,
 * so each one is read by name below instead of passing `process.env` whole.
 * Server-only variables live in `env.server.ts`.
 */

export const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

export const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());
export const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());

const publicSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_SENTRY_DSN: optionalUrl,
  NEXT_PUBLIC_POSTHOG_KEY: optionalString,
  NEXT_PUBLIC_POSTHOG_HOST: optionalUrl,
});

export type PublicEnv = z.infer<typeof publicSchema>;

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
}

export function parsePublicEnv(source: Record<string, string | undefined>): PublicEnv {
  const result = publicSchema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid public environment variables:\n${formatIssues(result.error)}\n` +
        'Copy .env.example to .env.local and fill in the missing values.',
    );
  }
  return result.data;
}

let cached: PublicEnv | undefined;

export function getPublicEnv(): PublicEnv {
  cached ??= parsePublicEnv({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  });
  return cached;
}
