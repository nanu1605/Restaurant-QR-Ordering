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
import { getServerEnv } from '@/lib/env.server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import { onboardRestaurant, OnboardError } from './onboard';
import {
  changePlanSchema,
  extendTrialSchema,
  manualPaymentSchema,
  onboardSchema,
  ownerPasswordSchema,
  restaurantIdSchema,
  suspendSchema,
  type ChangePlanInput,
  type ExtendTrialInput,
  type ManualPaymentInput,
  type OnboardFormInput,
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

export type OnboardHandover = {
  restaurantId: string;
  slug: string;
  ownerUsername: string;
  /** The owner's real email, when one was given (they can log in with it too). */
  ownerEmail: string | null;
};

// Onboarding errors that belong to one field of the wizard.
const ONBOARD_FIELD_ERRORS: Record<string, { field: keyof OnboardFormInput; message: string }> = {
  SLUG_TAKEN: { field: 'slug', message: 'That restaurant code is taken. Choose another.' },
  INVALID_SLUG: { field: 'slug', message: 'Use 3–32 lowercase letters, numbers or hyphens.' },
  EMAIL_TAKEN: { field: 'ownerEmail', message: 'This email already has a login. Use another.' },
  USER_ALREADY_MEMBER: {
    field: 'ownerEmail',
    message: 'This email already belongs to a restaurant. Use another.',
  },
  INVALID_OWNER: { field: 'ownerUsername', message: 'Check the owner name and username.' },
  WEAK_PASSWORD: { field: 'ownerPassword', message: 'Use at least 8 characters.' },
  weak_password: { field: 'ownerPassword', message: 'Choose a longer, harder to guess password.' },
  PLAN_NOT_FOUND: { field: 'plan', message: 'That plan is switched off. Choose another.' },
};

/**
 * Creates a restaurant with its owner login and a trial (spec §13.4
 * onboarding, docs/DECISIONS.md P7-9). The owner's password stays in the
 * browser for the handover card; it isn't sent back.
 */
export async function onboardNewRestaurant(
  input: OnboardFormInput,
): Promise<ActionResult<OnboardHandover>> {
  const user = await requirePlatformAdmin();
  const parsed = onboardSchema.safeParse(input);
  if (!parsed.success) return fromZodError(parsed.error);
  const form = parsed.data;
  const optional = (value: string) => value || undefined;

  try {
    const result = await onboardRestaurant(createAdminClient(), {
      name: form.name,
      slug: form.slug,
      cuisine: form.cuisine,
      legalName: optional(form.legalName),
      addressLine: optional(form.addressLine),
      city: optional(form.city),
      state: optional(form.state),
      pincode: optional(form.pincode),
      phone: optional(form.phone),
      email: optional(form.email),
      ownerName: form.ownerName,
      ownerUsername: form.ownerUsername,
      ownerEmail: optional(form.ownerEmail),
      ownerPassword: form.ownerPassword,
      gstMode: form.gstMode,
      gstRateBps: form.gstRateBps,
      pricesIncludeTax: form.pricesIncludeTax,
      plan: form.plan,
      trialDays: form.trialDays,
      staffEmailDomain: getServerEnv().STAFF_EMAIL_DOMAIN,
      actorUserId: user.id,
    });
    return actionOk({
      restaurantId: result.restaurantId,
      slug: result.slug,
      ownerUsername: result.ownerUsername,
      ownerEmail: form.ownerEmail || null,
    });
  } catch (error) {
    if (!(error instanceof OnboardError)) throw error;
    const known = ONBOARD_FIELD_ERRORS[error.code];
    if (known) return actionError(known.message, { [known.field]: known.message });
    console.error('Onboarding failed:', error.code, error.message);
    return actionError(GENERIC_ERROR);
  }
}
