import { z } from 'zod';

/**
 * System health (docs/SUPER_ADMIN_PLAN.md 14d, docs/DECISIONS.md SA-86+):
 * scheduled jobs, webhooks, the email log, sizes and menu imports, as
 * platform_system() returns them.
 */

const iso = z.string();

const emailRowSchema = z.object({
  id: z.number(),
  kind: z.string(),
  status: z.enum(['sent', 'failed', 'duplicate', 'bounced', 'complained']),
  recipients: z.number(),
  provider_id: z.string().nullable(),
  http_status: z.number().nullable(),
  error: z.string().nullable(),
  created_at: iso,
  updated_at: iso.nullable(),
});
export type EmailRow = z.infer<typeof emailRowSchema>;
export const parseEmailRows = (json: unknown) => z.array(emailRowSchema).parse(json);

const systemSchema = z.object({
  jobs: z.array(
    z.object({
      job: z.string(),
      last_at: iso,
      missing: z.boolean(),
      ms: z.number().nullable(),
      steps: z.number(),
      failed: z.number(),
      missing_steps: z.number(),
    }),
  ),
  steps: z.array(
    z.object({
      job: z.string(),
      step: z.string(),
      started_at: iso,
      ms: z.number(),
      ok: z.boolean(),
      detail: z.string().nullable(),
      missing: z.boolean(),
    }),
  ),
  failures: z.array(
    z.object({ job: z.string(), step: z.string(), started_at: iso, detail: z.string().nullable() }),
  ),
  webhooks: z.object({ failed_24h: z.number(), failed_open: z.number() }),
  email: z.object({
    kinds: z.array(
      z.object({
        kind: z.string(),
        sent: z.number(),
        duplicate: z.number(),
        failed: z.number(),
        bounced: z.number(),
        complained: z.number(),
      }),
    ),
    recent: z.array(emailRowSchema),
  }),
  sizes: z.object({
    database_bytes: z.number(),
    db_limit_mb: z.number().nullable(),
    storage_limit_mb: z.number().nullable(),
    buckets: z.array(z.object({ bucket: z.string(), objects: z.number(), bytes: z.number() })),
  }),
  menu_imports: z.object({
    since: iso,
    imports: z.number(),
    photo: z.number(),
    csv: z.number(),
    imported: z.number(),
    failed: z.number(),
    discarded: z.number(),
    open: z.number(),
    cost_paise: z.number(),
    cost_unknown: z.number(),
  }),
});
export type SystemHealth = z.infer<typeof systemSchema>;
export const parseSystem = (json: unknown) => systemSchema.parse(json);

/** The jobs in vercel.json, by name in cron_runs. */
export const JOB_LABELS: Record<string, string> = {
  daily: 'Nightly job (3:00 AM)',
  digest: 'Morning digest (8:45 AM)',
};
export const jobLabel = (job: string) => JOB_LABELS[job] ?? job;

/** Each email's kind: the first part of its idempotency key. */
const EMAIL_KIND_LABELS: Record<string, string> = {
  signup: 'Signup codes',
  welcome: 'Welcome',
  'password-reset': 'Password resets',
  'team-invite': 'Team invites',
  reminder: 'Subscription reminders',
  announcement: 'Announcements',
  digest: 'Daily digest',
  support: 'Support requests',
  lead: 'New leads',
};
export const emailKindLabel = (kind: string) => EMAIL_KIND_LABELS[kind] ?? kind;

export const EMAIL_STATUS_LABELS: Record<EmailRow['status'], string> = {
  sent: 'Sent',
  duplicate: 'Already sent',
  failed: 'Failed',
  bounced: 'Bounced',
  complained: 'Marked as spam',
};

/** A size against its limit warns from here (SA-90). */
export const NEAR_LIMIT = 0.8;

/** Used / limit, or null when no limit is entered. */
export function limitShare(bytes: number, limitMb: number | null): number | null {
  return limitMb ? bytes / (limitMb * 1024 * 1024) : null;
}

export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0
    ? `${value} bytes`
    : `${value.toLocaleString('en-IN', { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

export function formatMs(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toLocaleString('en-IN', { maximumFractionDigits: 1 })} s`;
}
