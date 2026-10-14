'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';

import { actionError, actionOk, fromDbError, type ActionResult } from '@/lib/action-result';
import { requirePlatformPermission } from '@/lib/auth/guards';
import { GENERIC_ERROR } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

import {
  SUPPORT_PRIORITIES,
  SUPPORT_STATUSES,
  supportNoteSchema,
  type SupportNoteInput,
} from './support';

/** Working a request in the inbox (docs/DECISIONS.md SA-43). */

const patchSchema = z
  .object({
    status: z.enum(SUPPORT_STATUSES),
    priority: z.enum(SUPPORT_PRIORITIES),
    // Null: no one.
    assignee: z.uuid().nullable(),
  })
  .partial();

export async function updateSupportRequest(
  requestId: string,
  patch: z.infer<typeof patchSchema>,
): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.support');
  const id = z.uuid().safeParse(requestId);
  const values = patchSchema.safeParse(patch);
  if (!id.success || !values.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_update_support_request', {
    p_request_id: id.data,
    p_patch: values.data,
  });
  if (error) return fromDbError(error, 'platform_update_support_request');
  refresh();
  return actionOk();
}

/** An internal note: only the team sees it. */
export async function addSupportNote(
  requestId: string,
  input: SupportNoteInput,
): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.support');
  const id = z.uuid().safeParse(requestId);
  const note = supportNoteSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!note.success) {
    return actionError('Check the note.', { body: note.error.issues[0]?.message ?? '' });
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_add_support_note', {
    p_request_id: id.data,
    p_body: note.data.body,
  });
  if (error) return fromDbError(error, 'platform_add_support_note');
  refresh();
  return actionOk();
}
