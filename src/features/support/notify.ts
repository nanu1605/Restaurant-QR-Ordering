import 'server-only';

import { APP_NAME } from '@/lib/config';
import { emailConfig, escapeHtml, sendEmail } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';

import {
  CONTACT_METHOD_LABELS,
  SUPPORT_TOPIC_LABELS,
  type ContactMethod,
  type SupportTopic,
} from './support';

type EmailedRequest = {
  id: string;
  restaurantName: string;
  slug: string;
  name: string;
  topic: SupportTopic;
  message: string;
  contactMethod: ContactMethod;
  contact: string;
  screenshot: boolean;
};

/** Subject, plain text and HTML for the "new support request" email to the team. */
export function supportRequestEmail(request: EmailedRequest, appUrl: string) {
  const contact = request.contactMethod === 'email' ? request.contact : `+91 ${request.contact}`;
  const rows: Array<[string, string]> = [
    ['Restaurant', `${request.restaurantName} (${request.slug})`],
    ['From', request.name],
    ['About', SUPPORT_TOPIC_LABELS[request.topic]],
    ['Reach them', `${CONTACT_METHOD_LABELS[request.contactMethod]}: ${contact}`],
    ['Message', request.message],
    ['Screenshot', request.screenshot ? 'Attached in the inbox' : 'None'],
  ];
  const link = `${appUrl.replace(/\/+$/, '')}/super/support/${request.id}`;
  return {
    subject: `Support request: ${request.restaurantName}, ${SUPPORT_TOPIC_LABELS[request.topic]}`,
    text: [rows.map(([label, value]) => `${label}: ${value}`).join('\n'), `Open it: ${link}`].join(
      '\n\n',
    ),
    html: [
      '<table cellpadding="4">',
      ...rows.map(
        ([label, value]) =>
          `<tr><th align="left" valign="top">${label}</th><td style="white-space:pre-wrap">${escapeHtml(value)}</td></tr>`,
      ),
      '</table>',
      `<p><a href="${escapeHtml(link)}">Open the request</a></p>`,
      `<p>— ${APP_NAME}</p>`,
    ].join('\n'),
  };
}

/**
 * Emails a new request to the platform's support address (platform_settings).
 * Best effort: the request is already saved and in the inbox, with a Home alert.
 */
export async function notifySupportRequest(requestId: string): Promise<void> {
  const config = emailConfig();
  if (!config) {
    console.warn('[support] not emailed: RESEND_API_KEY or EMAIL_FROM not set');
    return;
  }
  const admin = createAdminClient();
  const [settings, request] = await Promise.all([
    admin.from('platform_settings').select('support_email').eq('id', 1).single(),
    admin
      .from('support_requests')
      .select(
        'id, topic, message, contact_method, contact, created_by_name, screenshot_path, restaurant:restaurants!inner (name, slug)',
      )
      .eq('id', requestId)
      .single(),
  ]);
  const to = settings.data?.support_email;
  if (!to) {
    console.warn('[support] not emailed: platform_settings.support_email is not set');
    return;
  }
  if (request.error) {
    console.error('[support] request not read for the email:', request.error.message);
    return;
  }
  const row = request.data;
  try {
    await sendEmail(config, {
      to: [to],
      ...supportRequestEmail(
        {
          id: row.id,
          restaurantName: row.restaurant.name,
          slug: row.restaurant.slug,
          name: row.created_by_name,
          topic: row.topic as SupportTopic,
          message: row.message,
          contactMethod: row.contact_method as ContactMethod,
          contact: row.contact,
          screenshot: row.screenshot_path !== null,
        },
        getPublicEnv().NEXT_PUBLIC_APP_URL,
      ),
      idempotencyKey: `support/${requestId}`,
    });
  } catch (error) {
    console.error('[support] email not sent:', error);
  }
}
