'use server';

import { refresh } from 'next/cache';
import { after } from 'next/server';

import { restaurantIdSchema } from '@/features/platform/schemas';
import { mandateCanCharge } from '@/features/subscriptions/autopay';
import { cancelMandate } from '@/features/subscriptions/razorpay-sync';
import {
  actionError,
  actionOk,
  fromDbError,
  fromZodError,
  type ActionResult,
} from '@/lib/action-result';
import { requireMember, requirePlatformPermission } from '@/lib/auth/guards';
import { dbErrorMessage, GENERIC_ERROR } from '@/lib/db-errors';
import { emailConfig } from '@/lib/email/resend';
import { razorpayConfig } from '@/lib/razorpay/razorpay';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import { closeAccountSchema, type CloseAccountInput } from './closure';
import { sendClosureEmail, type ClosedRestaurant } from './email';
import { buildExport } from './export';

/**
 * Closing an account and its data export (docs/SUPER_ADMIN_PLAN.md 14e,
 * docs/DECISIONS.md SA-93+). The database checks who is asking again and
 * writes the audit rows.
 */

const refused = (code: string) => dbErrorMessage({ code: 'P0001', message: code }) ?? GENERIC_ERROR;

function buildAfterResponse(restaurantId: string, exportId: string) {
  // Up to the page's maxDuration; a build that dies reads as failed (SA-93).
  after(() => buildExport(createAdminClient(), restaurantId, exportId));
}

/** The owner's copy, from Settings. A support session is never the owner. */
export async function requestOwnerExport(): Promise<ActionResult> {
  const membership = await requireMember(['owner']);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_request_data_export');
  if (error) return fromDbError(error, 'admin_request_data_export');
  buildAfterResponse(membership.restaurant.id, data);
  refresh();
  return actionOk();
}

export async function requestTeamExport(restaurantId: string): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.close');
  const id = restaurantIdSchema.safeParse(restaurantId);
  if (!id.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_request_data_export', {
    p_restaurant_id: id.data,
  });
  if (error) return fromDbError(error, 'platform_request_data_export');
  buildAfterResponse(id.data, data);
  refresh();
  return actionOk();
}

/**
 * Autopay goes first (SA-94): if Razorpay refuses, nothing has closed and the
 * team tries again, rather than a closed restaurant still being charged. So
 * what would refuse the close is checked before it, and again in the database.
 * Says whether the owner was emailed, so the team can tell them if not.
 */
export async function closeRestaurant(
  restaurantId: string,
  input: CloseAccountInput,
): Promise<ActionResult<{ emailed: boolean }>> {
  const user = await requirePlatformPermission('restaurants.close');
  const id = restaurantIdSchema.safeParse(restaurantId);
  const parsed = closeAccountSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);

  const supabase = await createClient();
  const { data: restaurant, error: loadError } = await supabase
    .from('restaurants')
    .select('slug, status')
    .eq('id', id.data)
    .maybeSingle();
  if (loadError) return fromDbError(loadError, 'close restaurant load');
  if (!restaurant) return actionError(refused('RESTAURANT_NOT_FOUND'));
  if (restaurant.status === 'closed') return actionError(refused('RESTAURANT_CLOSED'));
  if (parsed.data.code.toLowerCase() !== restaurant.slug) {
    const wrongCode = refused('CLOSE_CODE_MISMATCH');
    return actionError(wrongCode, { code: wrongCode });
  }

  const admin = createAdminClient();
  const { data: subscription, error: subscriptionError } = await admin
    .from('restaurant_subscriptions')
    .select('razorpay_subscription_id, razorpay_status, cancel_at_period_end')
    .eq('restaurant_id', id.data)
    .maybeSingle();
  if (subscriptionError) return fromDbError(subscriptionError, 'close restaurant subscription');
  if (
    subscription?.razorpay_subscription_id &&
    mandateCanCharge({
      razorpayStatus: subscription.razorpay_status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    })
  ) {
    const config = razorpayConfig();
    if (!config) {
      return actionError('Razorpay could still charge it and its keys aren’t set. Not closed.');
    }
    const stopped = await cancelMandate(
      config,
      id.data,
      user.id,
      subscription.razorpay_subscription_id,
      subscription.razorpay_status,
    );
    if (!stopped.ok)
      return actionError(`Autopay couldn’t be cancelled. Not closed. ${stopped.error}`);
  }

  const { data, error } = await supabase.rpc('platform_close_restaurant', {
    p_restaurant_id: id.data,
    p_code: parsed.data.code,
    p_reason: parsed.data.reason,
  });
  if (error) return fromDbError(error, 'platform_close_restaurant');

  const closed = data as ClosedRestaurant;
  const email = emailConfig();
  let emailed = false;
  if (email && closed.recipients.length > 0) {
    emailed = await sendClosureEmail(admin, email, id.data, closed).then(
      () => true,
      (sendError: unknown) => {
        console.error('[closure] closing email not sent', id.data, sendError);
        return false;
      },
    );
  }
  refresh();
  return actionOk({ emailed });
}

export async function reopenRestaurant(restaurantId: string): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.close');
  const id = restaurantIdSchema.safeParse(restaurantId);
  if (!id.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_reopen_restaurant', { p_restaurant_id: id.data });
  if (error) return fromDbError(error, 'platform_reopen_restaurant');
  refresh();
  return actionOk();
}
