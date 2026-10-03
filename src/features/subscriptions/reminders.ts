import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { APP_NAME } from '@/lib/config';
import { escapeHtml, sendEmail, type EmailConfig } from '@/lib/email/resend';
import type { Database } from '@/types/database';

import { formatDay, lastDay } from './summary';

/**
 * Subscription reminder emails, sent by the daily cron (spec §14.6,
 * docs/DECISIONS.md P8-12). The database says which are due; each is sent
 * with its key as Resend's idempotency key, then logged, so it goes out once.
 */

export type DueReminder =
  Database['public']['Functions']['subscription_reminders_due']['Returns'][number];

type ReminderEmail = { subject: string; paragraphs: string[] };

function content(reminder: DueReminder): ReminderEmail {
  const name = reminder.restaurant_name;
  const day = (iso: string | null) => (iso ? formatDay(iso, reminder.timezone) : 'soon');
  switch (reminder.kind) {
    case 'trial_ends_3d':
    case 'trial_ends_1d':
      return {
        subject: `Your ${APP_NAME} free trial ends on ${day(reminder.trial_ends_at)}`,
        paragraphs: [
          `The free trial of ${reminder.plan_name} for ${name} ends on ${day(reminder.trial_ends_at)}.`,
          'Choose a plan before then to keep taking orders. If you have already paid, you can ignore this email.',
        ],
      };
    case 'payment_failed':
      return {
        subject: `Payment failed for ${name}`,
        paragraphs: [
          `The last ${APP_NAME} payment for ${name} failed.`,
          `Pay by ${reminder.restriction_at ? lastDay(reminder.restriction_at, reminder.timezone) : 'soon'} to keep ordering on. Razorpay may try again; you can also pay another way.`,
        ],
      };
    default:
      return {
        subject: `Ordering is paused at ${name}`,
        paragraphs: [
          `The ${APP_NAME} subscription for ${name} has lapsed, so customers can't order and setup changes are paused. Nothing is lost.`,
          'Pay to turn ordering back on at once.',
        ],
      };
  }
}

/** Subject, plain text and HTML for one reminder. */
export function reminderEmail(reminder: DueReminder, appUrl: string) {
  const { subject, paragraphs } = content(reminder);
  const link = `${appUrl.replace(/\/+$/, '')}/admin/subscription`;
  return {
    subject,
    text: [...paragraphs, `Subscription page: ${link}`, `— ${APP_NAME}`].join('\n\n'),
    html: [
      ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
      `<p><a href="${escapeHtml(link)}">Open the subscription page</a></p>`,
      `<p>— ${APP_NAME}</p>`,
    ].join('\n'),
  };
}

/**
 * Sends every reminder due now. A failure is logged and left for the next
 * run; the others still go. Returns how many were sent and failed.
 */
export async function sendSubscriptionReminders(
  admin: SupabaseClient<Database>,
  config: EmailConfig,
  appUrl: string,
  { now = new Date(), pauseMs = 600 }: { now?: Date; pauseMs?: number } = {},
): Promise<{ sent: number; failed: number }> {
  const { data, error } = await admin.rpc('subscription_reminders_due', {
    p_at: now.toISOString(),
  });
  if (error) throw new Error(`Could not list due reminders: ${error.message}`);

  let sent = 0;
  let failed = 0;
  for (const [index, reminder] of data.entries()) {
    // ponytail: one at a time under Resend's 2 requests a second; batch sends if this grows past a few hundred.
    if (index > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    try {
      await sendEmail(config, {
        to: reminder.recipients,
        ...reminderEmail(reminder, appUrl),
        idempotencyKey: `reminder/${reminder.restaurant_id}/${reminder.kind}/${reminder.due_key}`,
      });
      const logged = await admin.rpc('subscription_reminder_sent', {
        p_restaurant_id: reminder.restaurant_id,
        p_kind: reminder.kind,
        p_due_key: reminder.due_key,
      });
      if (logged.error) throw new Error(`Sent but not logged: ${logged.error.message}`);
      sent += 1;
    } catch (sendError) {
      failed += 1;
      console.error('[reminders] not sent', reminder.restaurant_id, reminder.kind, sendError);
    }
  }
  return { sent, failed };
}
