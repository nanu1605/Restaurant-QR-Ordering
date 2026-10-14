import 'server-only';

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { APP_NAME } from '@/lib/config';
import { addDays } from '@/lib/date-range';
import { EmailError, escapeHtml, sendEmail, type EmailConfig } from '@/lib/email/resend';
import { formatINR } from '@/lib/money';
import type { Database } from '@/types/database';

import { ATTENTION_GROUPS, attentionGroupLabel } from './home';
import { formatDate, todayInIndia } from './platform';

/**
 * The daily digest (docs/SUPER_ADMIN_PLAN.md 12e, docs/DECISIONS.md SA-31):
 * yesterday's key numbers and today's Needs attention counts, emailed at
 * 08:45 India time to every platform admin, once a day.
 */

const digestSchema = z.object({
  day: z.string(),
  states: z.object({
    mrr_paise: z.number(),
    paid: z.number(),
    trial: z.number(),
    payment_failed: z.number(),
  }),
  collected: z.object({ base_paise: z.number(), gst_paise: z.number(), count: z.number() }),
  signups: z.number(),
  onboarded: z.number(),
  leads: z.number(),
  usage: z.object({ gmv_paise: z.number(), orders: z.number() }),
  attention: z.object({
    total: z.number(),
    inactive_days: z.number(),
    groups: z.array(z.object({ group: z.enum(ATTENTION_GROUPS), count: z.number() })),
  }),
  recipients: z.array(z.string()),
});
export type Digest = z.infer<typeof digestSchema>;
export const parseDigest = (json: unknown) => digestSchema.parse(json);

const rupees = (paise: number) => formatINR(paise, { fraction: 'auto' });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Subject, plain text and HTML for one day's digest. */
export function digestEmail(digest: Digest, appUrl: string) {
  const day = formatDate(`${digest.day}T12:00:00+05:30`);
  const { states, collected, usage, attention } = digest;
  const numbers = [
    `MRR ${rupees(states.mrr_paise)} before GST: ${states.paid} paid, ${plural(states.trial, 'trial', 'trials')}, ${states.payment_failed} with a failed payment.`,
    `Collected ${rupees(collected.base_paise)} + GST ${rupees(collected.gst_paise)} in ${plural(collected.count, 'payment', 'payments')}.`,
    `${plural(digest.signups, 'signup', 'signups')}, ${digest.onboarded} onboarded by the team, ${plural(digest.leads, 'lead', 'leads')}.`,
    `Restaurants took ${plural(usage.orders, 'order', 'orders')}; diners paid ${rupees(usage.gmv_paise)} (GMV, taxes included).`,
  ];
  const groups = attention.groups.map(
    ({ group, count }) => `${attentionGroupLabel(group, attention.inactive_days)}: ${count}`,
  );
  const needs =
    attention.total === 0
      ? 'Nothing needs attention today.'
      : `Needs attention today: ${attention.total}.`;
  const link = `${appUrl.replace(/\/+$/, '')}/super`;
  return {
    subject: `${APP_NAME} on ${day}: ${attention.total} ${attention.total === 1 ? 'thing needs' : 'things need'} attention`,
    text: [
      `Yesterday, ${day}`,
      numbers.join('\n'),
      [needs, ...groups.map((line) => `- ${line}`)].join('\n'),
      `Home: ${link}`,
      `— ${APP_NAME}`,
    ].join('\n\n'),
    html: [
      `<p><strong>Yesterday, ${escapeHtml(day)}</strong></p>`,
      `<ul>${numbers.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
      `<p><strong>${escapeHtml(needs)}</strong></p>`,
      groups.length > 0
        ? `<ul>${groups.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
        : '',
      `<p><a href="${escapeHtml(link)}">Open Home</a></p>`,
      `<p>— ${APP_NAME}</p>`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** Recipients per email: Resend takes up to 50. */
const CHUNK = 50;

/** The same recipients on the same day share Resend's idempotency key. */
export function digestKey(day: string, recipients: string[]): string {
  return `digest/${day}/${createHash('sha256').update(recipients.join(',')).digest('hex').slice(0, 16)}`;
}

/**
 * Sends yesterday's digest unless it went out already (a successful run in
 * cron_runs). The result is what cron_runs records.
 */
export async function sendDigest(
  admin: SupabaseClient<Database>,
  config: EmailConfig | null,
  appUrl: string,
  now = new Date(),
): Promise<{ day: string; sent: number } | { day: string; skipped: string }> {
  const day = addDays(todayInIndia(now), -1);
  if (!config) return { day, skipped: 'email is not set up' };

  const earlier = await admin
    .from('cron_runs')
    .select('id')
    .eq('job', 'digest')
    .eq('ok', true)
    .like('detail', `{"day":"${day}","sent":%`)
    .limit(1);
  if (earlier.error) throw new Error(`Could not check earlier digests: ${earlier.error.message}`);
  if (earlier.data.length > 0) return { day, skipped: 'already sent' };

  const { data, error } = await admin.rpc('platform_digest', { p_day: day });
  if (error) throw new Error(`Could not load the digest: ${error.message}`);
  const digest = parseDigest(data);
  const email = digestEmail(digest, appUrl);
  let sent = 0;
  for (let start = 0; start < digest.recipients.length; start += CHUNK) {
    const to = digest.recipients.slice(start, start + CHUNK);
    try {
      await sendEmail(config, { to, ...email, idempotencyKey: digestKey(day, to) });
    } catch (error) {
      // 409: this key went out earlier with that morning's counts (a run that
      // timed out after Resend took it); count it as sent and go on.
      if (!(error instanceof EmailError && error.status === 409)) throw error;
    }
    sent += to.length;
  }
  return { day, sent };
}
