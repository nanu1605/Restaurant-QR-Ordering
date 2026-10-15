import { NextResponse } from 'next/server';

import { sendAnnouncementEmails } from '@/features/announcements/email';
import { fillHindiNames } from '@/features/menu/hindi-names';
import { todayInIndia } from '@/features/platform/platform';
import { removeOldImportPhotos } from '@/features/menu-import/cleanup';
import { sendSubscriptionReminders } from '@/features/subscriptions/reminders';
import { SCREENSHOT_BUCKET } from '@/features/support/support';
import { cronAuthorised, cronStep } from '@/lib/cron';
import { emailConfig } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';
import { addDays } from '@/lib/date-range';
import { createAdminClient } from '@/lib/supabase/admin';

const noStore = { 'Cache-Control': 'no-store' };

// The Hindi name sweep makes up to 100 model calls, five at a time.
export const maxDuration = 300;

type Admin = ReturnType<typeof createAdminClient>;

/** One step of the nightly job, recorded in cron_runs (docs/DECISIONS.md SA-11). */
const step = <T>(admin: Admin, name: string, run: () => Promise<T>) =>
  cronStep(admin, 'daily', name, run);

/**
 * Daily housekeeping, called by the scheduler in vercel.json (spec §14.6,
 * docs/DECISIONS.md P7-20, P8-12, HN-8): the super-admin snapshots (SA-9),
 * first, before signups are cleaned up; then menu import photo cleanup,
 * subscription reminder emails, then announcements on their first day (SA-83;
 * both skipped until Resend is set up), Hindi names that menu edits didn't
 * fill (skipped without a menu import key), website signups older than a
 * week (W-9), password resets older than a day (P11-6), storefront photos of
 * signups that never finished (P11-12), support screenshots of requests
 * that were never sent (SA-42), and email log rows older than 30 days (SA-87).
 */
export async function GET(request: Request) {
  if (!cronAuthorised(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStore });
  }
  const admin = createAdminClient();
  const email = emailConfig();
  if (!email) console.warn('[cron/daily] reminders skipped: RESEND_API_KEY or EMAIL_FROM not set');

  // Counts today's signups before the cleanup below can delete any.
  const snapshot = await step(admin, 'metrics snapshot', async () => {
    const { data, error } = await admin.rpc('platform_metrics_snapshot', {});
    if (error) throw new Error(error.message);
    return data;
  });
  const today = todayInIndia();
  const reminderEmails = step(admin, 'reminders', async () =>
    email
      ? sendSubscriptionReminders(admin, email, getPublicEnv().NEXT_PUBLIC_APP_URL)
      : { skipped: true },
  );
  const [
    usage,
    menuImports,
    reminders,
    announcements,
    hindiNames,
    signups,
    passwordResets,
    emailLog,
    storefrontPhotos,
    supportScreenshots,
    supportSessions,
  ] = await Promise.all([
    // Recounts the last few business days (late payments, voids), in its own transaction.
    step(admin, 'usage snapshot', async () => {
      const { data, error } = await admin.rpc('platform_metrics_backfill_usage', {
        p_from: addDays(today, -4),
        p_to: today,
      });
      if (error) throw new Error(error.message);
      return { rows: data };
    }),
    step(admin, 'menu import cleanup', () => removeOldImportPhotos(admin)),
    reminderEmails,
    // After the reminders: one email at a time under Resend's limit (SA-83).
    reminderEmails.then(() =>
      step(admin, 'announcement emails', async () =>
        email
          ? sendAnnouncementEmails(admin, email, getPublicEnv().NEXT_PUBLIC_APP_URL)
          : { skipped: true },
      ),
    ),
    step(admin, 'hindi names', () => fillHindiNames(admin, null, 500)),
    step(admin, 'signup cleanup', async () => {
      const { data, error } = await admin.rpc('site_signups_cleanup');
      if (error) throw new Error(error.message);
      return { deleted: data };
    }),
    step(admin, 'password reset cleanup', async () => {
      const { data, error } = await admin.rpc('password_resets_cleanup');
      if (error) throw new Error(error.message);
      return { deleted: data };
    }),
    step(admin, 'email log cleanup', async () => {
      const { data, error } = await admin.rpc('email_log_cleanup');
      if (error) throw new Error(error.message);
      return { deleted: data };
    }),
    step(admin, 'storefront photo cleanup', async () => {
      const { data: paths, error } = await admin.rpc('storefront_photos_to_remove', {
        p_limit: 500,
      });
      if (error) throw new Error(error.message);
      if (paths.length > 0) {
        const removed = await admin.storage.from('storefront-photos').remove(paths);
        if (removed.error) throw new Error(removed.error.message);
      }
      return { deleted: paths.length };
    }),
    // Pages of 500 until done (at most 10,000 a night).
    step(admin, 'support screenshot cleanup', async () => {
      let deleted = 0;
      for (let round = 0; round < 20; round++) {
        const { data: paths, error } = await admin.rpc('support_screenshots_to_remove', {
          p_limit: 500,
        });
        if (error) throw new Error(error.message);
        if (paths.length > 0) {
          const removed = await admin.storage.from(SCREENSHOT_BUCKET).remove(paths);
          if (removed.error) throw new Error(removed.error.message);
        }
        deleted += paths.length;
        if (paths.length < 500) break;
      }
      return { deleted };
    }),
    // Support windows that ran out (access already ended on time; SA-48).
    step(admin, 'support session cleanup', async () => {
      const { data, error } = await admin.rpc('support_sessions_close_expired');
      if (error) throw new Error(error.message);
      return { closed: data };
    }),
  ]);
  const ok = [
    snapshot,
    usage,
    menuImports,
    reminders,
    announcements,
    hindiNames,
    signups,
    passwordResets,
    emailLog,
    storefrontPhotos,
    supportScreenshots,
    supportSessions,
  ].every((result) => result !== null);
  return NextResponse.json(
    {
      ok,
      snapshot,
      usage,
      menuImports,
      reminders,
      announcements,
      hindiNames,
      signups,
      passwordResets,
      emailLog,
      storefrontPhotos,
      supportScreenshots,
      supportSessions,
    },
    { status: ok ? 200 : 500, headers: noStore },
  );
}
