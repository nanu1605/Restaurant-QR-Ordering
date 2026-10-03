import 'server-only';

import { createHmac } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { APP_NAME } from '@/lib/config';
import { escapeHtml, sendEmail, type EmailConfig } from '@/lib/email/resend';
import { getServerEnv } from '@/lib/env.server';
import type { Database } from '@/types/database';

import type { Lead } from './schemas';

/** A keyed hash of the visitor's IP: enough for the rate limit, not the address itself. */
export function hashIp(ip: string): string {
  return createHmac('sha256', getServerEnv().CUSTOMER_COOKIE_SECRET).update(ip).digest('hex');
}

/** Subject, plain text and HTML for the platform's "new lead" email. */
export function leadEmail(lead: Lead, planName: string | null, appUrl: string) {
  const rows: Array<[string, string]> = [
    ['Name', lead.name],
    ['Restaurant', lead.restaurantName],
    ['City', lead.city],
    ['Phone', `+91 ${lead.phone}`],
    ['Email', lead.email ?? '—'],
    ['Plan', planName ?? 'Not chosen'],
    ['Message', lead.message ?? '—'],
  ];
  const link = `${appUrl.replace(/\/+$/, '')}/super/leads`;
  return {
    subject: `Demo request: ${lead.restaurantName}, ${lead.city}`,
    text: [
      rows.map(([label, value]) => `${label}: ${value}`).join('\n'),
      `All leads: ${link}`,
    ].join('\n\n'),
    html: [
      '<table cellpadding="4">',
      ...rows.map(
        ([label, value]) =>
          `<tr><th align="left" valign="top">${label}</th><td style="white-space:pre-wrap">${escapeHtml(value)}</td></tr>`,
      ),
      '</table>',
      `<p><a href="${escapeHtml(link)}">See all leads</a></p>`,
      `<p>— ${APP_NAME}</p>`,
    ].join('\n'),
  };
}

/**
 * Emails a new lead to the platform's support address (platform_settings).
 * Best effort: the lead is already saved and listed in /super/leads.
 */
export async function notifyLead(
  admin: SupabaseClient<Database>,
  config: EmailConfig,
  leadId: string,
  lead: Lead,
  appUrl: string,
): Promise<void> {
  const [settings, plan] = await Promise.all([
    admin.from('platform_settings').select('support_email').eq('id', 1).single(),
    lead.planCode
      ? admin.from('plans').select('name').eq('code', lead.planCode).maybeSingle()
      : Promise.resolve(null),
  ]);
  const to = settings.data?.support_email;
  if (!to) {
    console.warn('[leads] not emailed: platform_settings.support_email is not set');
    return;
  }
  try {
    await sendEmail(config, {
      to: [to],
      ...leadEmail(lead, plan?.data?.name ?? null, appUrl),
      idempotencyKey: `lead/${leadId}`,
    });
  } catch (error) {
    console.error('[leads] email not sent:', error);
  }
}
