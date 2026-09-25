'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';

import { actionError, actionOk, fromDbError, type ActionResult } from '@/lib/action-result';
import { requireMember, requireUser } from '@/lib/auth/guards';
import { APP_NAME } from '@/lib/config';
import { GENERIC_ERROR } from '@/lib/db-errors';
import {
  cancelSubscription,
  createSubscription,
  fetchSubscription,
  RazorpayError,
  razorpayConfig,
  verifyCheckoutSignature,
  type RazorpayConfig,
  type SubscriptionEntity,
} from '@/lib/razorpay/razorpay';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/types/database';

import { autopayStartAt, autopayState, cancelsAtCycleEnd, TOTAL_COUNT } from './autopay';

/**
 * The owner's Razorpay autopay (spec §14.3, docs/DECISIONS.md P8-6, P8-7):
 * start a subscription for Checkout, confirm Checkout's reply, cancel. The
 * server checks the owner, talks to Razorpay, then saves what Razorpay says
 * through razorpay_save_subscription (service role only). Webhooks remain
 * the source of truth for payments.
 */

const NOT_SET_UP = 'Paying online is not set up yet. Contact support to pay.';
const RAZORPAY_DOWN = 'Razorpay could not be reached. Try again in a minute.';
const RAZORPAY_REFUSED = 'Razorpay refused this. Contact support if it keeps happening.';

export type CheckoutStart = {
  keyId: string;
  subscriptionId: string;
  name: string;
  description: string;
  prefill: { name?: string; email?: string; contact?: string };
};

const startSchema = z.object({
  planCode: z.string().regex(/^[a-z_]{2,30}$/),
  cycle: z.enum(['monthly', 'yearly']),
});

const confirmSchema = z.object({
  paymentId: z.string().regex(/^pay_[A-Za-z0-9]{1,40}$/),
  subscriptionId: z.string().regex(/^sub_[A-Za-z0-9]{1,40}$/),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});

type Owner = { userId: string; restaurantId: string; config: RazorpayConfig };

async function ownerWithRazorpay(): Promise<Owner | null> {
  const user = await requireUser();
  const membership = await requireMember(['owner']);
  const config = razorpayConfig();
  if (!config) return null;
  return { userId: user.id, restaurantId: membership.restaurant.id, config };
}

async function loadSubscription(restaurantId: string) {
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

async function save(
  owner: Owner,
  entity: SubscriptionEntity,
  cancelScheduled = false,
): Promise<ActionResult<void>> {
  const { error } = await createAdminClient().rpc('razorpay_save_subscription', {
    p_restaurant_id: owner.restaurantId,
    p_entity: entity as Json,
    p_actor_user_id: owner.userId,
    p_cancel_scheduled: cancelScheduled,
  });
  return error ? fromDbError(error, 'razorpay_save_subscription') : actionOk();
}

function razorpayFailed(error: unknown, context: string) {
  console.error(`[subscriptions] ${context}`, error);
  if (!(error instanceof RazorpayError)) return actionError(GENERIC_ERROR);
  return actionError(
    error.kind === 'network' || error.kind === 'timeout' ? RAZORPAY_DOWN : RAZORPAY_REFUSED,
  );
}

/**
 * Creates the Razorpay subscription Checkout will authorise. The first charge
 * waits for the end of a running trial or paid period. A subscription left
 * unfinished, or one whose payments are failing, is cancelled first.
 */
export async function startSubscription(input: unknown): Promise<ActionResult<CheckoutStart>> {
  const owner = await ownerWithRazorpay();
  if (!owner) return actionError(NOT_SET_UP);
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) return actionError(GENERIC_ERROR);
  const { planCode, cycle } = parsed.data;

  const admin = createAdminClient();
  const [subscription, plan, restaurant] = await Promise.all([
    loadSubscription(owner.restaurantId),
    admin
      .from('plans')
      .select('name, is_active, razorpay_plan_id_monthly, razorpay_plan_id_yearly')
      .eq('code', planCode)
      .maybeSingle(),
    admin
      .from('restaurants')
      .select('name, email, phone, status')
      .eq('id', owner.restaurantId)
      .single(),
  ]);
  if (plan.error || restaurant.error) {
    console.error(
      '[subscriptions] could not load plan or restaurant',
      plan.error,
      restaurant.error,
    );
    return actionError(GENERIC_ERROR);
  }
  const planId =
    cycle === 'monthly' ? plan.data?.razorpay_plan_id_monthly : plan.data?.razorpay_plan_id_yearly;
  if (!plan.data?.is_active || !planId) {
    return actionError('This plan can’t be paid online yet. Choose another or contact support.');
  }
  if (restaurant.data.status === 'suspended') {
    return actionError('This restaurant is suspended. Contact support to restore it first.');
  }
  if (autopayState(subscription) === 'on') {
    return actionError('Autopay is already set up. Refresh the page to see it.');
  }

  try {
    // An unfinished checkout, or a mandate that keeps failing, makes way.
    const old = subscription.razorpaySubscriptionId;
    if (old && ['created', 'pending', 'halted'].includes(subscription.razorpayStatus ?? '')) {
      const cancelled = await cancelSubscription(owner.config, old, false);
      const saved = await save(owner, cancelled);
      if (!saved.ok) return saved;
    }

    const entity = await createSubscription(owner.config, {
      planId,
      totalCount: TOTAL_COUNT[cycle],
      startAt: autopayStartAt(subscription, new Date()),
      notes: { restaurant_id: owner.restaurantId, plan_code: planCode, billing_cycle: cycle },
    });
    const saved = await save(owner, entity);
    if (!saved.ok) {
      await cancelSubscription(owner.config, entity.id, false).catch((error) =>
        console.error('[subscriptions] could not cancel an unsaved subscription', entity.id, error),
      );
      return saved;
    }

    return actionOk({
      keyId: owner.config.keyId,
      subscriptionId: entity.id,
      name: APP_NAME,
      description: `${plan.data.name}, ${cycle}`,
      prefill: {
        name: restaurant.data.name,
        email: restaurant.data.email ?? undefined,
        contact: restaurant.data.phone ?? undefined,
      },
    });
  } catch (error) {
    return razorpayFailed(error, 'could not start a subscription');
  }
}

/**
 * Checkout's success reply: the signature proves it came from Razorpay; the
 * subscription is then fetched and saved, so the page shows autopay at once
 * even before the webhook arrives.
 */
export async function confirmCheckout(input: unknown): Promise<ActionResult<void>> {
  const owner = await ownerWithRazorpay();
  if (!owner) return actionError(NOT_SET_UP);
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success || !verifyCheckoutSignature(parsed.data, owner.config.keySecret)) {
    return actionError(
      'The payment could not be confirmed here. If money was taken, it will show on this page within a few minutes.',
    );
  }
  const subscription = await loadSubscription(owner.restaurantId);
  if (subscription.razorpaySubscriptionId !== parsed.data.subscriptionId) {
    return actionError('This checkout is out of date. Refresh the page.');
  }
  try {
    const entity = await fetchSubscription(owner.config, parsed.data.subscriptionId);
    const saved = await save(owner, entity);
    refresh();
    return saved;
  } catch (error) {
    return razorpayFailed(error, 'could not confirm checkout');
  }
}

/**
 * Stops autopay. A subscription that has charged runs to the end of its paid
 * period; one that hasn't charged yet (set up during a trial) ends now.
 * Razorpay can't undo a cancel; the owner can subscribe again later.
 */
export async function cancelAutopay(): Promise<ActionResult<void>> {
  const owner = await ownerWithRazorpay();
  if (!owner) return actionError(NOT_SET_UP);
  const subscription = await loadSubscription(owner.restaurantId);
  if (autopayState(subscription) !== 'on' || !subscription.razorpaySubscriptionId) {
    return actionError('Autopay is not on. Refresh the page.');
  }
  const id = subscription.razorpaySubscriptionId;
  const atCycleEnd = cancelsAtCycleEnd(subscription.razorpayStatus);
  let entity: SubscriptionEntity;
  try {
    entity = await cancelSubscription(owner.config, id, atCycleEnd);
  } catch (error) {
    // Razorpay cancels only once: an earlier try may have gone through with
    // its reply (or the save after it) lost. Then save what Razorpay has.
    const current = await fetchSubscription(owner.config, id).catch(() => null);
    const done =
      current !== null &&
      (current.status === 'cancelled' || (atCycleEnd && current.has_scheduled_changes === true));
    if (!done) return razorpayFailed(error, 'could not cancel autopay');
    entity = current;
  }
  const saved = await save(owner, entity, atCycleEnd);
  refresh();
  return saved;
}
