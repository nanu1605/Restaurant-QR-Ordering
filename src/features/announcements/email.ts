import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { APP_NAME } from '@/lib/config';
import { escapeHtml, sendEmail, sendFailure, type EmailConfig } from '@/lib/email/resend';
import type { JobRun } from '@/lib/jobs';
import type { Database } from '@/types/database';

/**
 * Announcement emails to restaurant owners (docs/DECISIONS.md SA-83, VPS-28):
 * one per restaurant, when the announcement starts. The database says which
 * are due; each goes with its key as Resend's idempotency key, then is
 * recorded.
 */

type DueEmail = Database['public']['Functions']['announcement_emails_next']['Returns'][number];

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
 * How long a run keeps starting sends (docs/DECISIONS.md VPS-25, VPS-28). A send started then
 * finishes, so a run ends inside the 300 s that the page saving an announcement allows on Vercel.
 */
export const EMAIL_RUN_MS = 200_000;
/** New due emails a round takes; each round lists the due emails again. */
const ROUND = 50;
/** Refusals in a row that point at the setup (EMAIL_FROM) rather than at addresses. */
const REFUSALS_TO_PAUSE = 3;
const PAUSE_MS = 30 * 60_000;
/** Unavailable answers since an email last went that end a save's or the daily run. */
const UNAVAILABLE_TO_STOP = 3;

// Until when the emails wait after those refusals, in this process. On globalThis, as the job
// gates are: Next can bundle this file more than once.
const PAUSED_UNTIL = Symbol.for('menumesh.announcementEmailsPausedUntil');
const pause = globalThis as { [PAUSED_UNTIL]?: number };

const pairOf = (email: DueEmail) => `${email.announcement_id}/${email.restaurant_id}`;

/** One email under its pair's key: sent, or how it failed (sendFailure), with Resend's answer. */
async function send(config: EmailConfig, email: DueEmail, appUrl: string) {
  try {
    await sendEmail(config, {
      to: email.recipients,
      ...announcementEmail(email, appUrl),
      idempotencyKey: `announcement/${pairOf(email)}`,
    });
    return { outcome: 'sent' as const };
  } catch (error) {
    return { outcome: sendFailure(error), error };
  }
}

export type AnnouncementEmailsRun =
  | {
      sent: number;
      duplicate: number;
      refused: number;
      stopped?: 'unavailable' | 'refused' | 'database';
    }
  | { skipped: 'paused' };

/**
 * Sends the announcement emails due (docs/DECISIONS.md VPS-28), listed again each round with up to
 * 50 new ones, until none is left or the run stops starting work; send starts are at least
 * pauseMs apart. An email sent again after a run was cut off goes under the same key, so Resend
 * answers as before without a second email, and it is recorded then. When a send fails:
 * - Resend is still busy with the key: it is left for the next run;
 * - any other 409: Resend holds an email for the key, so it is recorded as sent;
 * - refused (400, 422: an address Resend won't take): set aside for 20 hours, and the others go
 *   on. Three in a row point at the setup (EMAIL_FROM) instead: the run ends and the emails wait
 *   30 minutes in this process, rather than setting the whole audience aside;
 * - anything else (no answer, 401, 403, 429, 5xx): nothing is recorded, for the next run to send.
 *   The minute job's run ends there, as its next run comes within a minute. A save's or the daily
 *   run goes on with the others, as on Vercel no minute job comes, and ends at the third such
 *   answer since an email last went.
 * The minute job (minuteJob) takes only announcements that have started or whose emails have
 * begun. Throws when the list can't be read.
 */
export async function sendAnnouncementEmails(
  admin: SupabaseClient<Database>,
  config: EmailConfig,
  appUrl: string,
  {
    run,
    minuteJob = false,
    pauseMs = 600,
    now = () => new Date(),
  }: { run: JobRun; minuteJob?: boolean; pauseMs?: number; now?: () => Date },
): Promise<AnnouncementEmailsRun> {
  if (Date.now() < (pause[PAUSED_UNTIL] ?? -Infinity)) return { skipped: 'paused' };

  const counts = { sent: 0, duplicate: 0, refused: 0 };
  let stopped: 'unavailable' | 'refused' | 'database' | undefined;
  // What this run has sent or asked for: an email Resend was still busy with stays due.
  const tried = new Set<string>();
  // Of those, the ones still listed (in flight, or unavailable and gone on past). Each round lists
  // that many more, up to the 500 the list gives, so that they cannot crowd out the new ones.
  let leftDue = 0;
  let refusedInARow = 0;
  let unavailableInARow = 0;
  let lastStart = -Infinity;

  while (!stopped && !run.stopping()) {
    const { data, error } = await admin.rpc('announcement_emails_next', {
      p_at: now().toISOString(),
      p_limit: Math.min(ROUND + leftDue, 500),
      p_minute_job: minuteJob,
    });
    if (error) throw new Error(`Could not list due announcement emails: ${error.message}`);
    const due = data.filter((email) => !tried.has(pairOf(email)));
    if (due.length === 0) break;

    for (const email of due) {
      // ponytail: one at a time under Resend's 2 requests a second, as reminders; batch sends past a few hundred restaurants.
      const wait = lastStart + pauseMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (run.stopping()) break;
      lastStart = Date.now();
      tried.add(pairOf(email));

      const { outcome, error: sendError } = await send(config, email, appUrl);
      if (outcome === 'in_flight') {
        leftDue += 1;
        continue;
      }
      if (outcome === 'unavailable') {
        unavailableInARow += 1;
        if (minuteJob || unavailableInARow >= UNAVAILABLE_TO_STOP) {
          console.warn(
            '[announcements] Resend unavailable, the next run sends the rest',
            sendError,
          );
          stopped = 'unavailable';
          break;
        }
        // Already tried, so this run doesn't ask again.
        console.warn(
          '[announcements] Resend unavailable, the next run sends',
          pairOf(email),
          sendError,
        );
        leftDue += 1;
        continue;
      }
      const pair = {
        p_announcement_id: email.announcement_id,
        p_restaurant_id: email.restaurant_id,
      };
      if (outcome === 'refused') {
        console.warn('[announcements] refused', pairOf(email), sendError);
        const setAside = await admin.rpc('announcement_email_failed', {
          ...pair,
          p_error: sendError instanceof Error ? sendError.message : String(sendError),
        });
        if (setAside.error) {
          console.error(
            '[announcements] refusal not recorded',
            pairOf(email),
            setAside.error.message,
          );
          stopped = 'database';
          break;
        }
        counts.refused += 1;
        refusedInARow += 1;
        if (refusedInARow >= REFUSALS_TO_PAUSE) {
          pause[PAUSED_UNTIL] = Date.now() + PAUSE_MS;
          console.error(
            '[announcements] three emails refused in a row, so none goes for 30 minutes: check EMAIL_FROM',
            sendError,
          );
          stopped = 'refused';
          break;
        }
        continue;
      }

      // Sent, or Resend already had an email for the key.
      const recorded = await admin.rpc('announcement_email_sent', pair);
      if (recorded.error) {
        // Resend has it: the next run sends it again under its key and records it.
        console.error(
          '[announcements] sent but not recorded',
          pairOf(email),
          recorded.error.message,
        );
        stopped = 'database';
        break;
      }
      counts[outcome === 'sent' ? 'sent' : 'duplicate'] += 1;
      refusedInARow = 0;
      unavailableInARow = 0;
    }
  }

  const result = stopped ? { ...counts, stopped } : counts;
  if (counts.sent + counts.duplicate + counts.refused > 0) {
    console.info('[announcements] emails', result);
  }
  return result;
}
