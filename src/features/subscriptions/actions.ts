'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';

import { actionError, actionOk, type ActionResult } from '@/lib/action-result';
import { requireMember, requireUser } from '@/lib/auth/guards';
import { APP_NAME } from '@/lib/config';
import { GENERIC_ERROR } from '@/lib/db-errors';
import {
  cancelSubscription,
  createSubscription,
  fetchSubscription,
  razorpayConfig,
  verifyCheckoutSignature,
  type RazorpayConfig,
  type SubscriptionEntity,
} from '@/lib/razorpay/razorpay';
import { createAdminClient } from '@/lib/supabase/admin';

import { autopayStartAt, autopayState, TOTAL_COUNT } from './autopay';
import { loadSubscription, razorpayFailed, saveSubscription, stopAutopay } from './razorpay-sync';

/**
 * The owner's Razorpay autopay (spec §14.3, docs/DECISIONS.md P8-6, P8-7):
 * start a subscription for Checkout, confirm Checkout's reply, cancel. The
 * server checks the owner, talks to Razorpay, then saves what Razorpay says
 * through razorpay_save_subscription (service role only). Webhooks remain
 * the source of truth for payments.
 */

const NOT_SET_UP = 'Paying online is not set up yet. Contact support to pay.';

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

function save(owner: Owner, entity: SubscriptionEntity) {
  return saveSubscription(owner.restaurantId, owner.userId, entity);
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
 * Stops autopay: at the end of the paid period once it has charged, at once
 * while it hasn't (a trial's mandate).
 */
export async function cancelAutopay(): Promise<ActionResult<void>> {
  const owner = await ownerWithRazorpay();
  if (!owner) return actionError(NOT_SET_UP);
  const saved = await stopAutopay(owner.config, owner.restaurantId, owner.userId);
  refresh();
  return saved;
}
