'use server';

import { refresh } from 'next/cache';

import { parsePriceInput } from '@/features/menu/schemas';
import { autopayState } from '@/features/subscriptions/autopay';
import { withGst } from '@/features/subscriptions/gst';
import { stopAutopay, syncSubscription } from '@/features/subscriptions/razorpay-sync';
import {
  actionError,
  actionOk,
  fromDbError,
  fromZodError,
  type ActionResult,
} from '@/lib/action-result';
import { requirePlatformAdmin, requirePlatformPermission } from '@/lib/auth/guards';
import { APP_NAME } from '@/lib/config';
import { GENERIC_ERROR } from '@/lib/db-errors';
import { getServerEnv } from '@/lib/env.server';
import {
  createPaymentLink,
  createPlan,
  RazorpayError,
  razorpayConfig,
} from '@/lib/razorpay/razorpay';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import { SNOOZE_DAYS, type SnoozeDays } from './home';
import { onboardRestaurant, OnboardError } from './onboard';
import { TAG_COLOURS, type SearchResults, type TagColour } from './platform';
import {
  getPlatformSettings,
  getRestaurantDetail,
  getSetupFee,
  searchPlatform as search,
} from './queries';
import { noteSchema, tagNameSchema, type NoteInput } from './restaurant-page';
import { discountEndsAt, discountLastDay } from './setup-fee';
import {
  changePlanSchema,
  extendTrialSchema,
  manualPaymentSchema,
  onboardSchema,
  ownerPasswordSchema,
  paymentLinkSchema,
  planFormSchema,
  platformSettingsSchema,
  restaurantIdSchema,
  savedViewSchema,
  suspendSchema,
  type ChangePlanInput,
  type ExtendTrialInput,
  type ManualPaymentInput,
  type OnboardFormInput,
  type OwnerPasswordInput,
  type PaymentLinkInput,
  type PlanFormInput,
  type PlatformSettingsInput,
  type SavedViewInput,
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

/** Whether the payment moved the paid period forward (it may cover time already paid). */
export async function recordManualPayment(
  restaurantId: string,
  input: ManualPaymentInput,
): Promise<ActionResult<{ extended: boolean }>> {
  await requirePlatformAdmin();
  const id = restaurantIdSchema.safeParse(restaurantId);
  const parsed = manualPaymentSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);

  const supabase = await createClient();
  if (parsed.data.purpose === 'setup_fee') {
    // The fee and discount in force, so launch-offer use can be counted (SA-8).
    const fee = await getSetupFee();
    const { error } = await supabase.rpc('platform_record_setup_fee', {
      p_restaurant_id: id.data,
      p_payment: {
        amount_paise: parsePriceInput(parsed.data.amount),
        mode: parsed.data.mode,
        notes: parsed.data.notes || null,
        list_price_paise: fee.feePaise,
        discount_paise: fee.discountPaise,
      },
    });
    if (error) return fromDbError(error, 'platform_record_setup_fee');
    refresh();
    return actionOk({ extended: false });
  }
  const { data, error } = await supabase.rpc('platform_record_manual_payment', {
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
  return actionOk({ extended: (data as { extended?: boolean }).extended === true });
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
      acquisitionChannel: form.acquisitionChannel,
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

/**
 * Creates the Razorpay plan for one cycle from the saved price and stores its
 * id (spec §19 Phase 8 task 1, docs/DECISIONS.md P8-10).
 */
export async function createRazorpayPlan(
  planId: string,
  cycle: 'monthly' | 'yearly',
): Promise<ActionResult> {
  await requirePlatformAdmin();
  const id = restaurantIdSchema.safeParse(planId);
  if (!id.success || (cycle !== 'monthly' && cycle !== 'yearly')) {
    return actionError(GENERIC_ERROR);
  }
  const config = razorpayConfig();
  if (!config) return actionError('Add the Razorpay keys to the environment first.');

  const supabase = await createClient();
  const { data: plan, error: readError } = await supabase
    .from('plans')
    .select(
      'code, name, price_monthly_paise, price_yearly_paise, razorpay_plan_id_monthly, razorpay_plan_id_yearly',
    )
    .eq('id', id.data)
    .maybeSingle();
  if (readError || !plan) return actionError('That plan no longer exists.');
  const existing =
    cycle === 'monthly' ? plan.razorpay_plan_id_monthly : plan.razorpay_plan_id_yearly;
  if (existing) return actionError('This plan already has a Razorpay plan for that cycle.');
  const amountPaise = cycle === 'monthly' ? plan.price_monthly_paise : plan.price_yearly_paise;
  if (amountPaise < 100) return actionError('Razorpay plans cost at least ₹1.');

  let razorpayId: string;
  try {
    razorpayId = (
      await createPlan(config, {
        cycle,
        name: `${APP_NAME} ${plan.name} — ${cycle}`,
        // Plan prices are before GST; each charge adds it (docs/DECISIONS.md W-11).
        amountPaise: withGst(amountPaise),
        notes: { plan_code: plan.code },
      })
    ).id;
  } catch (error) {
    console.error('[plans] could not create a Razorpay plan', error);
    return actionError(
      error instanceof RazorpayError ? `Razorpay refused: ${error.message}` : GENERIC_ERROR,
    );
  }

  const { error } = await supabase.rpc('platform_update_plan', {
    p_plan_id: id.data,
    p_patch: { [`razorpay_plan_id_${cycle}`]: razorpayId },
  });
  if (error) return fromDbError(error, 'platform_update_plan');
  refresh();
  return actionOk();
}

/** Saves a plan (spec §13.4 Plans); the database audits what changed. */
export async function updatePlan(planId: string, input: PlanFormInput): Promise<ActionResult> {
  await requirePlatformAdmin();
  const id = restaurantIdSchema.safeParse(planId);
  const parsed = planFormSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);
  const plan = parsed.data;
  const limit = (text: string) => (text === '' ? null : Number(text));

  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_update_plan', {
    p_plan_id: id.data,
    p_patch: {
      name: plan.name,
      price_monthly_paise: parsePriceInput(plan.priceMonthly),
      price_yearly_paise: parsePriceInput(plan.priceYearly),
      max_tables: limit(plan.maxTables),
      max_staff: limit(plan.maxStaff),
      features: plan.features,
      razorpay_plan_id_monthly: plan.razorpayMonthly || null,
      razorpay_plan_id_yearly: plan.razorpayYearly || null,
      is_active: plan.isActive,
      sort_order: plan.sortOrder,
    },
  });
  if (error) return fromDbError(error, 'platform_update_plan');
  refresh();
  return actionOk();
}

/** Saves the platform settings (docs/DECISIONS.md SA-4); the database audits what changed. */
export async function updatePlatformSettings(input: PlatformSettingsInput): Promise<ActionResult> {
  await requirePlatformPermission('settings.manage');
  const parsed = platformSettingsSchema.safeParse(input);
  if (!parsed.success) return fromZodError(parsed.error);
  const settings = parsed.data;
  // The form shows the end as a day. Unless that day changed, keep the stored time, which
  // need not be midnight (e.g. set in SQL to end the offer at once).
  const stored = (await getPlatformSettings()).setup_fee_discount_ends_at;
  const dayChanged = (stored ? discountLastDay(stored) : '') !== settings.discountLastDay;

  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_update_settings', {
    p_patch: {
      trial_days: settings.trialDays,
      grace_days: settings.graceDays,
      setup_fee_paise: parsePriceInput(settings.setupFee),
      setup_fee_discount_paise: parsePriceInput(settings.setupFeeDiscount),
      ...(dayChanged && {
        setup_fee_discount_ends_at: settings.discountLastDay
          ? discountEndsAt(settings.discountLastDay)
          : null,
      }),
      support_phone: settings.supportPhone || null,
      support_email: settings.supportEmail || null,
      health_setup_days: settings.healthSetupDays,
      health_inactive_days: settings.healthInactiveDays,
      health_slowing_percent: settings.healthSlowingPercent,
      health_slowing_min_orders: settings.healthSlowingMinOrders,
    },
  });
  if (error) return fromDbError(error, 'platform_update_settings');
  refresh();
  return actionOk();
}

/**
 * Saves the restaurants list's current filters, sort and columns under a name
 * (docs/DECISIONS.md SA-24); the same name again replaces the view.
 */
export async function saveView(
  query: string,
  input: SavedViewInput,
): Promise<ActionResult<{ id: string }>> {
  await requirePlatformPermission('restaurants.view');
  const parsed = savedViewSchema.safeParse(input);
  if (!parsed.success) return fromZodError(parsed.error);
  // Rebuilt so only plain key=value pairs reach the database; the page number isn't kept.
  const params = new URLSearchParams(query);
  params.delete('page');
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_save_view', {
    p_page: 'restaurants',
    p_name: parsed.data.name,
    p_query: params.toString(),
    p_shared: parsed.data.shared,
  });
  if (error) return fromDbError(error, 'platform_save_view');
  refresh();
  return actionOk({ id: data });
}

export async function deleteView(viewId: string): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.view');
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_delete_view', { p_id: viewId });
  if (error) return fromDbError(error, 'platform_delete_view');
  refresh();
  return actionOk();
}

/** Puts a Needs attention item aside for this admin (docs/DECISIONS.md SA-28). */
export async function snoozeAttention(key: string, days: SnoozeDays): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.view');
  if (!SNOOZE_DAYS.includes(days) || key.length > 120) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_snooze', { p_key: key, p_days: days });
  if (error) return fromDbError(error, 'platform_snooze');
  refresh();
  return actionOk();
}

/**
 * The alerts were opened: nothing up to `seen`, the newest one shown, is new
 * any more (docs/DECISIONS.md SA-30).
 */
export async function markAlertsSeen(seen: string): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.view');
  if (Number.isNaN(Date.parse(seen))) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_mark_alerts_seen', { p_seen: seen });
  if (error) return fromDbError(error, 'platform_mark_alerts_seen');
  return actionOk();
}

/** The search box (docs/DECISIONS.md SA-25). */
export async function searchPlatform(q: string): Promise<ActionResult<SearchResults>> {
  await requirePlatformPermission('restaurants.view');
  try {
    return actionOk(await search(q.slice(0, 80)));
  } catch (error) {
    console.error('[platform] search failed', error);
    return actionError(GENERIC_ERROR);
  }
}

const NO_RAZORPAY = 'Add the Razorpay keys to the environment first.';

/**
 * Sends a Razorpay Payment Link for a subscription period or the setup fee
 * (spec §14.5, docs/DECISIONS.md P8-5, P8-11). Razorpay emails or texts it to
 * the restaurant; its payment arrives as payment_link.paid. A subscription
 * link is refused while autopay is on, so nobody pays twice.
 */
export async function sendPaymentLink(
  restaurantId: string,
  input: PaymentLinkInput,
): Promise<ActionResult<{ shortUrl: string; sentTo: string[] }>> {
  const user = await requirePlatformAdmin();
  const id = restaurantIdSchema.safeParse(restaurantId);
  const parsed = paymentLinkSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);
  const config = razorpayConfig();
  if (!config) return actionError(NO_RAZORPAY);

  const detail = await getRestaurantDetail(id.data);
  const subscription = detail?.subscription;
  if (!detail || !subscription) return actionError('This restaurant has no subscription yet.');
  const { purpose, months, description } = parsed.data;
  const autopay = autopayState({
    razorpayStatus: subscription.razorpay_status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });
  if (purpose === 'subscription' && autopay === 'on') {
    return actionError(
      'Autopay is on, so a subscription link would charge twice. Cancel autopay first, or send a setup fee link.',
    );
  }

  const amountPaise = parsePriceInput(parsed.data.amount) as number;
  // A setup fee link carries the fee and discount in force; the paid webhook
  // stores them with the payment (SA-8).
  const fee = purpose === 'setup_fee' ? await getSetupFee() : null;
  const owner = detail.owners.find((o) => o.is_active && o.email_is_real && o.email);
  const email = detail.restaurant.email ?? owner?.email ?? undefined;
  const contact = detail.restaurant.phone ?? undefined;
  let link: { id: string; short_url: string };
  try {
    link = await createPaymentLink(config, {
      amountPaise,
      description,
      notes:
        purpose === 'subscription'
          ? { restaurant_id: id.data, purpose, months: String(months) }
          : {
              restaurant_id: id.data,
              purpose,
              list_price_paise: String(fee!.feePaise),
              discount_paise: String(fee!.discountPaise),
            },
      customer: { name: detail.restaurant.name, email, contact },
    });
  } catch (error) {
    console.error('[payment links] could not create a payment link', error);
    return actionError(
      error instanceof RazorpayError ? `Razorpay refused: ${error.message}` : GENERIC_ERROR,
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_audit_payment_link', {
    p_restaurant_id: id.data,
    p_link: {
      id: link.id,
      short_url: link.short_url,
      amount_paise: amountPaise,
      purpose,
      months: purpose === 'subscription' ? months : null,
    },
  });
  // The link exists now; its payment is recorded either way.
  if (error) console.error('[payment links] not audited', link.id, user.id, error.message);
  refresh();
  // Razorpay notifies only the email and phone it was given.
  return actionOk({
    shortUrl: link.short_url,
    sentTo: [email, contact].filter((to) => !!to) as string[],
  });
}

/** Saves what Razorpay says about the restaurant's subscription now. */
export async function syncRazorpay(restaurantId: string): Promise<ActionResult> {
  const user = await requirePlatformAdmin();
  const id = restaurantIdSchema.safeParse(restaurantId);
  if (!id.success) return actionError(GENERIC_ERROR);
  const config = razorpayConfig();
  if (!config) return actionError(NO_RAZORPAY);
  const saved = await syncSubscription(config, id.data, user.id);
  refresh();
  return saved;
}

/** Stops the restaurant's autopay, as the owner can (at period end once it has charged). */
export async function cancelRestaurantAutopay(restaurantId: string): Promise<ActionResult> {
  const user = await requirePlatformAdmin();
  const id = restaurantIdSchema.safeParse(restaurantId);
  if (!id.success) return actionError(GENERIC_ERROR);
  const config = razorpayConfig();
  if (!config) return actionError(NO_RAZORPAY);
  const saved = await stopAutopay(config, id.data, user.id);
  refresh();
  return saved;
}

/** Runs a failed webhook again; returns what happened. */
export async function reprocessWebhook(
  eventId: string,
): Promise<ActionResult<{ result: string; error: string | null }>> {
  await requirePlatformAdmin();
  const id = restaurantIdSchema.safeParse(eventId);
  if (!id.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_reprocess_webhook', { p_event_id: id.data });
  if (error) return fromDbError(error, 'platform_reprocess_webhook');
  refresh();
  const outcome = data as { result: string; error: string | null };
  return actionOk({ result: outcome.result, error: outcome.error });
}

// ─── A restaurant's notes, tags and account manager (docs/DECISIONS.md SA-38, SA-39) ──

export async function addNote(
  restaurantId: string,
  input: NoteInput,
  pinned = false,
): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.manage');
  const id = restaurantIdSchema.safeParse(restaurantId);
  const parsed = noteSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_add_note', {
    p_restaurant_id: id.data,
    p_body: parsed.data.body,
    p_pinned: pinned,
  });
  if (error) return fromDbError(error, 'platform_add_note');
  refresh();
  return actionOk();
}

export async function editNote(noteId: string, input: NoteInput): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.manage');
  const id = restaurantIdSchema.safeParse(noteId);
  const parsed = noteSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_edit_note', {
    p_note_id: id.data,
    p_body: parsed.data.body,
  });
  if (error) return fromDbError(error, 'platform_edit_note');
  refresh();
  return actionOk();
}

export async function pinNote(noteId: string, pinned: boolean): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.manage');
  const id = restaurantIdSchema.safeParse(noteId);
  if (!id.success || typeof pinned !== 'boolean') return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_pin_note', {
    p_note_id: id.data,
    p_pinned: pinned,
  });
  if (error) return fromDbError(error, 'platform_pin_note');
  refresh();
  return actionOk();
}

/** A new tag; returns its id so the form can tick it. */
export async function createTag(name: string, colour: TagColour): Promise<ActionResult<string>> {
  await requirePlatformPermission('restaurants.manage');
  const parsed = tagNameSchema.safeParse({ name });
  if (!parsed.success) return fromZodError(parsed.error);
  if (!TAG_COLOURS.includes(colour)) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_create_tag', {
    p_name: parsed.data.name,
    p_colour: colour,
  });
  if (error) return fromDbError(error, 'platform_create_tag');
  return actionOk(data);
}

export async function deleteTag(tagId: string): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.manage');
  const id = restaurantIdSchema.safeParse(tagId);
  if (!id.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_delete_tag', { p_tag_id: id.data });
  if (error) return fromDbError(error, 'platform_delete_tag');
  refresh();
  return actionOk();
}

export async function setRestaurantTags(
  restaurantId: string,
  tagIds: string[],
): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.manage');
  const id = restaurantIdSchema.safeParse(restaurantId);
  const tags = restaurantIdSchema.array().max(10).safeParse(tagIds);
  if (!id.success || !tags.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_set_restaurant_tags', {
    p_restaurant_id: id.data,
    p_tag_ids: tags.data,
  });
  if (error) return fromDbError(error, 'platform_set_restaurant_tags');
  refresh();
  return actionOk();
}

/** `userId` null: no account manager. */
export async function setAccountManager(
  restaurantId: string,
  userId: string | null,
): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.manage');
  const id = restaurantIdSchema.safeParse(restaurantId);
  const user = restaurantIdSchema.nullable().safeParse(userId);
  if (!id.success || !user.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_set_account_manager', {
    p_restaurant_id: id.data,
    // A null clears it.
    p_user_id: user.data as string,
  });
  if (error) return fromDbError(error, 'platform_set_account_manager');
  refresh();
  return actionOk();
}
