'use server';

import { refresh } from 'next/cache';

import { parsePriceInput } from '@/features/menu/schemas';
import {
  actionError,
  actionOk,
  fromDbError,
  fromZodError,
  type ActionResult,
} from '@/lib/action-result';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { GENERIC_ERROR } from '@/lib/db-errors';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import {
  changePlanSchema,
  extendTrialSchema,
  manualPaymentSchema,
  ownerPasswordSchema,
  restaurantIdSchema,
  suspendSchema,
  type ChangePlanInput,
  type ExtendTrialInput,
  type ManualPaymentInput,
  type OwnerPasswordInput,
  type SuspendInput,
} from './schemas';

/**
 * Platform actions on one restaurant (spec §13.4, docs/DECISIONS.md P7-4).
 * The database checks the platform admin and second factor again and writes
 * the audit rows.
 */

export async function suspendRestaurant(
  restaurantId: string,
  input: SuspendInput,
): Promise<ActionResult> {
  await requirePlatformAdmin();
  const id = restaurantIdSchema.safeParse(restaurantId);
  const parsed = suspendSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_set_restaurant_status', {
    p_restaurant_id: id.data,
    p_status: 'suspended',
    p_reason: parsed.data.reason,
  });
  if (error) return fromDbError(error, 'platform_set_restaurant_status');
  refresh();
  return actionOk();
}

export async function unsuspendRestaurant(restaurantId: string): Promise<ActionResult> {
  await requirePlatformAdmin();
  const id = restaurantIdSchema.safeParse(restaurantId);
  if (!id.success) return actionError(GENERIC_ERROR);

  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_set_restaurant_status', {
    p_restaurant_id: id.data,
    p_status: 'active',
    p_reason: '',
  });
  if (error) return fromDbError(error, 'platform_set_restaurant_status');
  refresh();
  return actionOk();
}

export async function extendTrial(
  restaurantId: string,
  input: ExtendTrialInput,
): Promise<ActionResult> {
  await requirePlatformAdmin();
  const id = restaurantIdSchema.safeParse(restaurantId);
  const parsed = extendTrialSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_extend_trial', {
    p_restaurant_id: id.data,
    p_days: parsed.data.days,
  });
  if (error) return fromDbError(error, 'platform_extend_trial');
  refresh();
  return actionOk();
}

export async function changePlan(
  restaurantId: string,
  input: ChangePlanInput,
): Promise<ActionResult> {
  await requirePlatformAdmin();
  const id = restaurantIdSchema.safeParse(restaurantId);
  const parsed = changePlanSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_change_plan', {
    p_restaurant_id: id.data,
    p_plan_code: parsed.data.planCode,
  });
  if (error) return fromDbError(error, 'platform_change_plan');
  refresh();
  return actionOk();
}

export async function recordManualPayment(
  restaurantId: string,
  input: ManualPaymentInput,
): Promise<ActionResult> {
  await requirePlatformAdmin();
  const id = restaurantIdSchema.safeParse(restaurantId);
  const parsed = manualPaymentSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_record_manual_payment', {
    p_restaurant_id: id.data,
    p_payment: {
      amount_paise: parsePriceInput(parsed.data.amount),
      mode: parsed.data.mode,
      billing_cycle: parsed.data.billingCycle,
      period_start: parsed.data.periodStart,
      period_end: parsed.data.periodEnd,
      notes: parsed.data.notes || null,
    },
  });
  if (error) return fromDbError(error, 'platform_record_manual_payment');
  refresh();
  return actionOk();
}

/** Sets a new password for a restaurant owner (the database logs it first). */
export async function resetOwnerPassword(
  memberId: string,
  input: OwnerPasswordInput,
): Promise<ActionResult> {
  await requirePlatformAdmin();
  const id = restaurantIdSchema.safeParse(memberId);
  const parsed = ownerPasswordSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);

  const supabase = await createClient();
  const { data: userId, error } = await supabase.rpc('platform_reset_owner_password', {
    p_member_id: id.data,
  });
  if (error) return fromDbError(error, 'platform_reset_owner_password');

  const { error: updateError } = await createAdminClient().auth.admin.updateUserById(userId, {
    password: parsed.data.password,
  });
  if (updateError) {
    if (updateError.code === 'weak_password') {
      const message = 'Choose a longer, harder to guess password.';
      return actionError(message, { password: message });
    }
    console.error('Owner password not updated:', updateError.code, updateError.message);
    return actionError(GENERIC_ERROR);
  }
  return actionOk();
}
