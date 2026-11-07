import 'server-only';

import { actionError, actionOk, fromDbError, type ActionResult } from '@/lib/action-result';
import { GENERIC_ERROR } from '@/lib/db-errors';
import {
  cancelSubscription,
  fetchSubscription,
  RazorpayError,
  type RazorpayConfig,
  type SubscriptionEntity,
} from '@/lib/razorpay/razorpay';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/types/database';

import { autopayState, cancelsAtCycleEnd } from './autopay';

/**
 * Reading and saving a restaurant's Razorpay subscription for the owner's
 * actions and super-admin's (docs/DECISIONS.md P8-6, P8-11). Callers check
 * who is asking first; saving goes through razorpay_save_subscription
 * (service role only), which audits the actor.
 */

const RAZORPAY_DOWN = 'Razorpay could not be reached. Try again in a minute.';
const RAZORPAY_REFUSED = 'Razorpay refused this. Contact support if it keeps happening.';

export async function loadSubscription(restaurantId: string) {
  const { data, error } = await createAdminClient()
    .from('restaurant_subscriptions')
    .select(
      'status, trial_ends_at, current_period_end, cancel_at_period_end, razorpay_subscription_id, razorpay_status',
    )
    .eq('restaurant_id', restaurantId)
    .single();
  if (error) throw new Error(`Could not load the subscription: ${error.message}`);
  return {
    status: data.status,
    trialEndsAt: data.trial_ends_at,
    currentPeriodEnd: data.current_period_end,
    cancelAtPeriodEnd: data.cancel_at_period_end,
    razorpaySubscriptionId: data.razorpay_subscription_id,
    razorpayStatus: data.razorpay_status,
  };
}

export async function saveSubscription(
  restaurantId: string,
  actorUserId: string,
  entity: SubscriptionEntity,
  cancelScheduled = false,
): Promise<ActionResult<void>> {
  const { error } = await createAdminClient().rpc('razorpay_save_subscription', {
    p_restaurant_id: restaurantId,
    p_entity: entity as Json,
    p_actor_user_id: actorUserId,
    p_cancel_scheduled: cancelScheduled,
  });
  return error ? fromDbError(error, 'razorpay_save_subscription') : actionOk();
}

export function razorpayFailed(error: unknown, context: string) {
  console.error(`[subscriptions] ${context}`, error);
  if (!(error instanceof RazorpayError)) return actionError(GENERIC_ERROR);
  return actionError(
    error.kind === 'network' || error.kind === 'timeout' ? RAZORPAY_DOWN : RAZORPAY_REFUSED,
  );
}

/**
 * Stops autopay. A subscription that has charged runs to the end of its paid
 * period; one that hasn't charged yet (set up during a trial) ends now.
 * Razorpay can't undo a cancel; the owner can subscribe again later.
 */
export async function stopAutopay(
  config: RazorpayConfig,
  restaurantId: string,
  actorUserId: string,
): Promise<ActionResult<void>> {
  const subscription = await loadSubscription(restaurantId);
  if (autopayState(subscription) !== 'on' || !subscription.razorpaySubscriptionId) {
    return actionError('Autopay is not on. Refresh the page.');
  }
  return cancelMandate(
    config,
    restaurantId,
    actorUserId,
    subscription.razorpaySubscriptionId,
    subscription.razorpayStatus,
  );
}

/** Cancels a mandate at Razorpay and saves what it says. Callers decide it should go. */
export async function cancelMandate(
  config: RazorpayConfig,
  restaurantId: string,
  actorUserId: string,
  id: string,
  razorpayStatus: string | null,
): Promise<ActionResult<void>> {
  const atCycleEnd = cancelsAtCycleEnd(razorpayStatus);
  let entity: SubscriptionEntity;
  try {
    entity = await cancelSubscription(config, id, atCycleEnd);
  } catch (error) {
    // Razorpay cancels only once: an earlier try may have gone through with
    // its reply (or the save after it) lost, or it ended the mandate itself (a
    // code's checkout expires after a day, with no webhook). Then save what it has.
    const current = await fetchSubscription(config, id).catch(() => null);
    const done =
      current !== null &&
      (['cancelled', 'completed', 'expired'].includes(current.status) ||
        (atCycleEnd && current.has_scheduled_changes === true));
    if (!done) return razorpayFailed(error, 'could not cancel autopay');
    entity = current;
  }
  return saveSubscription(restaurantId, actorUserId, entity, atCycleEnd);
}

/** Fetches the restaurant's Razorpay subscription and saves what Razorpay says. */
export async function syncSubscription(
  config: RazorpayConfig,
  restaurantId: string,
  actorUserId: string,
): Promise<ActionResult<void>> {
  const { razorpaySubscriptionId: id } = await loadSubscription(restaurantId);
  if (!id) return actionError('This restaurant has no Razorpay subscription.');
  let entity: SubscriptionEntity;
  try {
    entity = await fetchSubscription(config, id);
  } catch (error) {
    return razorpayFailed(error, 'could not fetch a subscription');
  }
  return saveSubscription(restaurantId, actorUserId, entity, entity.has_scheduled_changes === true);
}
