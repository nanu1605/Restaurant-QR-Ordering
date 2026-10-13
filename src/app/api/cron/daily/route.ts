import { createHash, timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { fillHindiNames } from '@/features/menu/hindi-names';
import { removeOldImportPhotos } from '@/features/menu-import/cleanup';
import { sendSubscriptionReminders } from '@/features/subscriptions/reminders';
import { emailConfig } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';
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

/** Runs one step; a failure is logged and doesn't stop the others. Null when it failed. */
async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    console.error(`[cron/daily] ${name} failed`, error);
    return null;
  }
}

/**
 * Daily housekeeping, called by the scheduler in vercel.json (spec §14.6,
 * docs/DECISIONS.md P7-20, P8-12, HN-8): menu import photo cleanup,
 * subscription reminder emails (skipped until Resend is set up), Hindi
 * names that menu edits didn't fill (skipped without a menu import key),
 * website signups older than a week (W-9), and password resets older than a
 * day (P11-6).
 */
export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStore });
  }
  const admin = createAdminClient();
  const email = emailConfig();
  if (!email) console.warn('[cron/daily] reminders skipped: RESEND_API_KEY or EMAIL_FROM not set');

  const [menuImports, reminders, hindiNames, signups, passwordResets] = await Promise.all([
    step('menu import cleanup', () => removeOldImportPhotos(admin)),
    email
      ? step('reminders', () =>
          sendSubscriptionReminders(admin, email, getPublicEnv().NEXT_PUBLIC_APP_URL),
        )
      : Promise.resolve({ skipped: true }),
    step('hindi names', () => fillHindiNames(admin, null, 500)),
    step('signup cleanup', async () => {
      const { data, error } = await admin.rpc('site_signups_cleanup');
      if (error) throw new Error(error.message);
      return { deleted: data };
    }),
    step('password reset cleanup', async () => {
      const { data, error } = await admin.rpc('password_resets_cleanup');
      if (error) throw new Error(error.message);
      return { deleted: data };
    }),
  ]);
  const ok = [menuImports, reminders, hindiNames, signups, passwordResets].every(
    (result) => result !== null,
  );
  return NextResponse.json(
    { ok, menuImports, reminders, hindiNames, signups, passwordResets },
    { status: ok ? 200 : 500, headers: noStore },
  );
}
