'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { ACQUISITION_CHANNELS } from '@/features/platform/platform';
import { actionError, actionOk, fromDbError, type ActionResult } from '@/lib/action-result';
import { requirePlatformPermission } from '@/lib/auth/guards';
import { GENERIC_ERROR } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

import {
  LEAD_STAGES,
  LOST_REASONS,
  newLeadSchema,
  parseLeadMatches,
  type LeadMatches,
  type NewLeadInput,
} from './leads';

/** The leads pipeline (docs/SUPER_ADMIN_PLAN.md 13d, docs/DECISIONS.md SA-53 to SA-55). */

/** A lead added by hand; on success, its page. */
export async function createLead(input: NewLeadInput): Promise<ActionResult> {
  await requirePlatformPermission('growth.manage');
  const parsed = newLeadSchema.safeParse(input);
  if (!parsed.success) {
    return actionError(
      'Check the highlighted fields and try again.',
      Object.fromEntries(
        parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]),
      ),
    );
  }
  const lead = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_create_lead', {
    p_lead: {
      name: lead.name,
      restaurant_name: lead.restaurantName,
      city: lead.city,
      phone: lead.phone,
      email: lead.email || null,
      channel: lead.channel,
      stage: lead.stage,
      message: lead.message || null,
      assignee: lead.assignee || null,
    },
  });
  if (error) return fromDbError(error, 'platform_create_lead');
  redirect(`/super/leads/${data}`);
}

/** Restaurants and leads that already have this mobile: the duplicate warning. */
export async function findLeadMatches(phone: string): Promise<LeadMatches | null> {
  await requirePlatformPermission('growth.manage');
  const parsed = z.string().max(20).safeParse(phone);
  if (!parsed.success) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_lead_matches', { p_phone: parsed.data });
  if (error) {
    console.error('platform_lead_matches failed:', error.message);
    return null;
  }
  return parseLeadMatches(data);
}

const patchSchema = z
  .object({
    stage: z.enum(LEAD_STAGES),
    lost_reason: z.enum(LOST_REASONS),
    // Null: no one, no time, no restaurant.
    assignee: z.uuid().nullable(),
    follow_up_at: z.string().max(40).nullable(),
    demo_at: z.string().max(40).nullable(),
    restaurant_code: z.string().trim().max(60).nullable(),
  })
  .partial();
export type LeadPatch = z.infer<typeof patchSchema>;

/** Stage, assignee, follow-up, demo or the linked restaurant. */
export async function updateLead(leadId: string, patch: LeadPatch): Promise<ActionResult> {
  await requirePlatformPermission('growth.manage');
  const id = z.uuid().safeParse(leadId);
  const values = patchSchema.safeParse(patch);
  if (!id.success || !values.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_update_lead', {
    p_lead_id: id.data,
    p_patch: values.data,
  });
  if (error) {
    if (error.message === 'RESTAURANT_NOT_FOUND') {
      return actionError('No restaurant has that code.', { restaurantCode: 'Check the code.' });
    }
    return fromDbError(error, 'platform_update_lead');
  }
  refresh();
  return actionOk();
}

/** A note on a lead; only the team sees it. */
export async function addLeadNote(leadId: string, input: { body: string }): Promise<ActionResult> {
  await requirePlatformPermission('growth.manage');
  const id = z.uuid().safeParse(leadId);
  const body = z.string().trim().min(1, 'Write the note.').max(2000).safeParse(input.body);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!body.success) return actionError('Check the note.', { body: body.error.issues[0]!.message });
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_add_lead_note', {
    p_lead_id: id.data,
    p_body: body.data,
  });
  if (error) return fromDbError(error, 'platform_add_lead_note');
  refresh();
  return actionOk();
}

/** How a restaurant found MenuMesh, set by the team (SA-59); null for not known. */
export async function setAcquisitionChannel(
  restaurantId: string,
  channel: string | null,
): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.manage');
  const id = z.uuid().safeParse(restaurantId);
  const value = z.enum(ACQUISITION_CHANNELS).nullable().safeParse(channel);
  if (!id.success || !value.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_set_acquisition_channel', {
    p_restaurant_id: id.data,
    // Empty: not known.
    p_channel: value.data ?? '',
  });
  if (error) return fromDbError(error, 'platform_set_acquisition_channel');
  refresh();
  return actionOk();
}
