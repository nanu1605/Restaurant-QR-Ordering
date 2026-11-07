import 'server-only';

import { formatDay } from '@/features/subscriptions/summary';
import { APP_NAME } from '@/lib/config';
import { escapeHtml, sendEmail, type EmailConfig } from '@/lib/email/resend';
import type { createAdminClient } from '@/lib/supabase/admin';

export type ClosedRestaurant = {
  name: string;
  timezone: string;
  removal_due_at: string;
  recipients: string[];
};

/** Subject, plain text and HTML of the email a closing sends its owner. */
export function closureEmail(
  closed: ClosedRestaurant,
  support: { email: string | null; phone: string | null },
) {
  const day = formatDay(closed.removal_due_at, closed.timezone);
  const reach = [support.email, support.phone].filter(Boolean).join(' or ');
  const contact = reach ? `${APP_NAME} support at ${reach}` : `${APP_NAME} support`;
  const paragraphs = [
    `The ${APP_NAME} account for ${closed.name} is closed. Logins have stopped, autopay is cancelled and its QR codes no longer take orders.`,
    `To reopen it, or to get a copy of your data, contact ${contact} by ${day}. After that, names, phone numbers, email addresses and logins are removed for good.`,
    'Bills, invoices and payment records are kept, as tax law requires.',
  ];
  return {
    subject: `${closed.name}: your ${APP_NAME} account is closed`,
    text: [...paragraphs, `— ${APP_NAME}`].join('\n\n'),
    html: [...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`), `<p>— ${APP_NAME}</p>`].join('\n'),
  };
}

export async function sendClosureEmail(
  admin: ReturnType<typeof createAdminClient>,
  config: EmailConfig,
  restaurantId: string,
  closed: ClosedRestaurant,
) {
  const { data } = await admin
    .from('platform_settings')
    .select('support_email, support_phone')
    .eq('id', 1)
    .single();
  await sendEmail(config, {
    to: closed.recipients,
    ...closureEmail(closed, {
      email: data?.support_email ?? null,
      phone: data?.support_phone ?? null,
    }),
    // Closing again the same day has the same date: each close gets its own email.
    idempotencyKey: `account-closed/${restaurantId}/${new Date().toISOString()}`,
  });
}
