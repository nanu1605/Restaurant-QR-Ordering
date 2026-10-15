import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { APP_NAME } from '@/lib/config';
import { escapeHtml, sendEmail, type EmailConfig } from '@/lib/email/resend';
import type { Database } from '@/types/database';

/**
 * Announcement emails to restaurant owners (docs/DECISIONS.md SA-83): one per
 * restaurant, when the announcement starts. The database says which are due;
 * each goes with its key as Resend's idempotency key, then is logged.
 */

type DueEmail = Database['public']['Functions']['announcement_emails_due']['Returns'][number];

/** Subject, plain text and HTML; the text's blank lines make paragraphs. */
export function announcementEmail(announcement: Pick<DueEmail, 'title' | 'body'>, appUrl: string) {
  const paragraphs = announcement.body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const link = `${appUrl.replace(/\/+$/, '')}/admin`;
  return {
    subject: `${APP_NAME}: ${announcement.title}`,
    text: [announcement.title, ...paragraphs, `Admin panel: ${link}`, `— ${APP_NAME}`].join('\n\n'),
    html: [
      `<p><strong>${escapeHtml(announcement.title)}</strong></p>`,
      ...paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`),
      `<p><a href="${escapeHtml(link)}">Open the admin panel</a></p>`,
      `<p>— ${APP_NAME}</p>`,
    ].join('\n'),
  };
}

/**
 * Sends every announcement email due now. A failure is logged and left for
 * the next run; the others still go.
 */
export async function sendAnnouncementEmails(
  admin: SupabaseClient<Database>,
  config: EmailConfig,
  appUrl: string,
  { now = new Date(), pauseMs = 600 }: { now?: Date; pauseMs?: number } = {},
): Promise<{ sent: number; failed: number }> {
  const { data, error } = await admin.rpc('announcement_emails_due', {
    p_at: now.toISOString(),
  });
  if (error) throw new Error(`Could not list due announcement emails: ${error.message}`);

  let sent = 0;
  let failed = 0;
  for (const [index, due] of data.entries()) {
    // ponytail: one at a time under Resend's 2 requests a second, as reminders; batch sends past a few hundred restaurants.
    if (index > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    try {
      await sendEmail(config, {
        to: due.recipients,
        ...announcementEmail(due, appUrl),
        idempotencyKey: `announcement/${due.announcement_id}/${due.restaurant_id}`,
      });
      const logged = await admin.rpc('announcement_email_sent', {
        p_announcement_id: due.announcement_id,
        p_restaurant_id: due.restaurant_id,
      });
      if (logged.error) throw new Error(`Sent but not logged: ${logged.error.message}`);
      sent += 1;
    } catch (sendError) {
      failed += 1;
      console.error('[announcements] not sent', due.announcement_id, due.restaurant_id, sendError);
    }
  }
  return { sent, failed };
}
