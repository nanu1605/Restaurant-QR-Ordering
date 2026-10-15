'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { actionError, actionOk, fromDbError, type ActionResult } from '@/lib/action-result';
import { requireMember, requirePlatformPermission } from '@/lib/auth/guards';
import { GENERIC_ERROR } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

import { staffNameSchema, supportHoursSchema } from './support-access';

/** Support sessions (docs/SUPER_ADMIN_PLAN.md 13c, docs/DECISIONS.md SA-46 to SA-52). */

/** The owner lets MenuMesh support in for 1, 4 or 24 hours. */
export async function allowSupportAccess(hours: number): Promise<ActionResult<string>> {
  await requireMember(['owner']);
  const parsed = supportHoursSchema.safeParse(hours);
  if (!parsed.success) return actionError(parsed.error.issues[0]!.message);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_allow_support_access', {
    p_hours: parsed.data,
  });
  if (error) return fromDbError(error, 'admin_allow_support_access');
  refresh();
  return actionOk(data);
}

/** The owner ends it, in use or not. */
export async function endSupportAccess(): Promise<ActionResult> {
  await requireMember(['owner']);
  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_end_support_access');
  if (error) return fromDbError(error, 'admin_end_support_access');
  refresh();
  return actionOk();
}

/** A team member takes the restaurant's open window and goes to its admin panel. */
export async function startSupportSession(
  restaurantId: string,
  staffName: string,
): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.support');
  const id = z.uuid().safeParse(restaurantId);
  const name = staffNameSchema.safeParse(staffName);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!name.success) {
    return actionError('Check your name.', { staffName: name.error.issues[0]!.message });
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_start_support_session', {
    p_restaurant_id: id.data,
    p_staff_name: name.data,
  });
  if (error) return fromDbError(error, 'platform_start_support_session');
  redirect('/admin');
}

/**
 * In person, right after creating the restaurant: the owner's consent is
 * recorded and a 24-hour session starts (SA-51).
 */
export async function startOnboardingSupportSession(
  restaurantId: string,
  staffName: string,
): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.support');
  const id = z.uuid().safeParse(restaurantId);
  const name = staffNameSchema.safeParse(staffName);
  if (!id.success || !name.success) {
    return actionError(name.error?.issues[0]?.message ?? GENERIC_ERROR);
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_onboarding_support_session', {
    p_restaurant_id: id.data,
    p_staff_name: name.data,
  });
  if (error) return fromDbError(error, 'platform_onboarding_support_session');
  return actionOk();
}

/** From the session's banner: end it and go back to the restaurant's page. */
export async function endSupportSession(): Promise<void> {
  const membership = await requireMember(['manager']);
  if (!membership.support) redirect('/admin');
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_end_support_session');
  if (error) throw new Error(`Could not end the support session: ${error.message}`);
  redirect(`/super/restaurants/${membership.restaurant.id}`);
}
