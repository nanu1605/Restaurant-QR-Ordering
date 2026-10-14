import { createHash, timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { fillHindiNames } from '@/features/menu/hindi-names';
import { todayInIndia } from '@/features/platform/platform';
import { removeOldImportPhotos } from '@/features/menu-import/cleanup';
import { sendSubscriptionReminders } from '@/features/subscriptions/reminders';
import { emailConfig } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';
import { addDays } from '@/lib/date-range';
import { getServerEnv } from '@/lib/env.server';
import { createAdminClient } from '@/lib/supabase/admin';

const noStore = { 'Cache-Control': 'no-store' };

// The Hindi name sweep makes up to 100 model calls, five at a time.
export const maxDuration = 300;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** `Authorization: Bearer <CRON_SECRET>`; nobody gets in while the secret is unset. */
function authorised(request: Request): boolean {
  const secret = getServerEnv().CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Runs one step and records it in cron_runs (docs/DECISIONS.md SA-11); a
 * failure is logged and doesn't stop the others. Null when it failed.
 */
async function step<T>(admin: Admin, name: string, run: () => Promise<T>): Promise<T | null> {
  const startedAt = new Date().toISOString();
  let result: T | null = null;
  let detail: string;
  try {
    result = await run();
    detail = JSON.stringify(result ?? null);
  } catch (error) {
    console.error(`[cron/daily] ${name} failed`, error);
    detail = error instanceof Error ? error.message : String(error);
  }
  const logged = await admin.from('cron_runs').insert({
    job: 'daily',
    step: name,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    ok: result !== null,
    detail: detail.slice(0, 2000),
  });
  if (logged.error) console.error(`[cron/daily] could not log ${name}`, logged.error.message);
  return result;
}

/**
 * Daily housekeeping, called by the scheduler in vercel.json (spec §14.6,
 * docs/DECISIONS.md P7-20, P8-12, HN-8): the super-admin snapshots (SA-9),
 * first, before signups are cleaned up; then menu import photo cleanup,
 * subscription reminder emails (skipped until Resend is set up), Hindi
 * names that menu edits didn't fill (skipped without a menu import key),
 * website signups older than a week (W-9), password resets older than a day
 * (P11-6), and storefront photos of signups that never finished (P11-12).
 */
export async function GET(request: Request) {
  if (!authorised(request)) {
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
  const [usage, menuImports, reminders, hindiNames, signups, passwordResets, storefrontPhotos] =
    await Promise.all([
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
      step(admin, 'reminders', async () =>
        email
          ? sendSubscriptionReminders(admin, email, getPublicEnv().NEXT_PUBLIC_APP_URL)
          : { skipped: true },
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
    ]);
  const ok = [
    snapshot,
    usage,
    menuImports,
    reminders,
    hindiNames,
    signups,
    passwordResets,
    storefrontPhotos,
  ].every((result) => result !== null);
  return NextResponse.json(
    {
      ok,
      snapshot,
      usage,
      menuImports,
      reminders,
      hindiNames,
      signups,
      passwordResets,
      storefrontPhotos,
    },
    { status: ok ? 200 : 500, headers: noStore },
  );
}
