'use server';

import { z } from 'zod';

import { actionOk, fromDbError, fromZodError, type ActionResult } from '@/lib/action-result';
import { requirePlatformPermission } from '@/lib/auth/guards';
import { hashEmail } from '@/lib/email/resend';
import { createClient } from '@/lib/supabase/server';

import { parseEmailRows, type EmailRow } from './system';

const addressSchema = z.object({
  email: z.email('Enter an email address.').max(254, 'Enter an email address.'),
});

/**
 * The latest emails to one address (system.view, again in SQL). Only its
 * keyed hash leaves the server; the address isn't stored or put in a URL
 * (docs/DECISIONS.md SA-87).
 */
export async function lookupEmailSends(email: string): Promise<ActionResult<EmailRow[]>> {
  await requirePlatformPermission('system.view');
  const parsed = addressSchema.safeParse({ email: email.trim() });
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_email_sends', {
    p_recipient_hash: hashEmail(parsed.data.email),
  });
  if (error) return fromDbError(error, 'platform_email_sends');
  return actionOk(parseEmailRows(data));
}
