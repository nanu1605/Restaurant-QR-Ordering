'use server';

import { refresh } from 'next/cache';
import { after } from 'next/server';
import { z } from 'zod';

import {
  actionError,
  actionOk,
  fromDbError,
  fromZodError,
  type ActionResult,
} from '@/lib/action-result';
import { requirePlatformPermission } from '@/lib/auth/guards';
import { GENERIC_ERROR } from '@/lib/db-errors';
import { emailConfig } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import { announcementPayload, announcementSchema, type AnnouncementInput } from './announcements';
import { sendAnnouncementEmails } from './email';

const idSchema = z.uuid();

/** Hides a banner for this login (a form in either panel). */
export async function dismissAnnouncement(formData: FormData): Promise<void> {
  const id = idSchema.safeParse(formData.get('id'));
  if (!id.success) return;
  const supabase = await createClient();
  const { error } = await supabase.rpc('member_dismiss_announcement', {
    p_announcement_id: id.data,
  });
  if (error) console.error('[announcements] could not hide', error.message);
  refresh();
}

/**
 * A new announcement or a change to one (settings.manage, again in SQL). One
 * that has started with email on is emailed now; a later one by the daily
 * run on its first day (docs/DECISIONS.md SA-83).
 */
export async function saveAnnouncement(
  input: AnnouncementInput,
  announcementId?: string,
): Promise<ActionResult<{ emailing: boolean }>> {
  await requirePlatformPermission('settings.manage');
  const parsed = announcementSchema.safeParse(input);
  const id = announcementId === undefined ? undefined : idSchema.safeParse(announcementId);
  if (id && !id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_save_announcement', {
    p_announcement: announcementPayload(parsed.data),
    ...(id && { p_announcement_id: id.data }),
  });
  if (error) return fromDbError(error, 'platform_save_announcement');
  const saved = data as { live: boolean; email: boolean };
  const config = saved.live && saved.email ? emailConfig() : null;
  if (config) {
    after(() =>
      sendAnnouncementEmails(createAdminClient(), config, getPublicEnv().NEXT_PUBLIC_APP_URL).catch(
        (sendError) => console.error('[announcements] could not email', sendError),
      ),
    );
  }
  refresh();
  return actionOk({ emailing: config !== null });
}

/** Takes it down now; it can't be started again. */
export async function endAnnouncement(announcementId: string): Promise<ActionResult> {
  await requirePlatformPermission('settings.manage');
  const id = idSchema.safeParse(announcementId);
  if (!id.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_save_announcement', {
    p_announcement_id: id.data,
    p_announcement: { ended: true },
  });
  if (error) return fromDbError(error, 'platform_save_announcement');
  refresh();
  return actionOk();
}
