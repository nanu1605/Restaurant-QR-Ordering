import type { FeatureKey } from '@/features/plans/plan-features';
import type { Database } from '@/types/database';

/**
 * Razorpay autopay rules shared by the owner's Subscription page and its
 * server actions (spec §14.3, docs/DECISIONS.md P8-6, P8-7).
 */

type Enums = Database['public']['Enums'];
export type BillingCycle = Enums['billing_cycle'];

/** A plan the owner can pay for online. */
export type CheckoutPlan = {
  code: string;
  name: string;
  monthlyPaise: number;
  yearlyPaise: number;
  maxTables: number | null;
  maxStaff: number | null;
  features: Record<FeatureKey, boolean>;
  /** Razorpay plans exist for these cycles. */
  cycles: BillingCycle[];
};

export type AutopayInput = {
  status: Enums['subscription_status'];
  razorpayStatus: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
};

/**
 * 'on': a mandate is set up and will keep charging. 'ending': it is set to
 * end with the paid period. 'off': nothing will charge.
 */
export function autopayState(
  subscription: Pick<AutopayInput, 'razorpayStatus' | 'cancelAtPeriodEnd'>,
): 'on' | 'ending' | 'off' {
  const live =
    subscription.razorpayStatus === 'authenticated' || subscription.razorpayStatus === 'active';
  if (!live) return 'off';
  return subscription.cancelAtPeriodEnd ? 'ending' : 'on';
}

/**
 * Whether Razorpay could still charge: autopay is on, or a checkout or a retry
 * hasn't ended, which 'on' leaves out. Closing an account stops them all
 * (docs/DECISIONS.md SA-94).
 */
export function mandateCanCharge(
  subscription: Pick<AutopayInput, 'razorpayStatus' | 'cancelAtPeriodEnd'>,
): boolean {
  return (
    autopayState(subscription) === 'on' ||
    ['created', 'pending', 'halted'].includes(subscription.razorpayStatus ?? '')
  );
}

/** Months charged before Razorpay stops: long enough to never matter. */
export const TOTAL_COUNT: Record<BillingCycle, number> = { monthly: 120, yearly: 10 };

// A start this close is treated as now; Razorpay needs start_at in the future.
const START_MARGIN_MS = 10 * 60 * 1000;

/**
 * When the first charge should happen: at the end of a running trial or paid
 * period, so nobody pays twice for the same days; otherwise now (null).
 */
export function autopayStartAt(subscription: AutopayInput, now: Date): Date | null {
  const covered =
    subscription.status === 'trialing'
      ? subscription.trialEndsAt
      : subscription.status === 'active' || subscription.status === 'cancelled'
        ? subscription.currentPeriodEnd
        : null;
  if (!covered) return null;
  const at = new Date(covered);
  return at.getTime() > now.getTime() + START_MARGIN_MS ? at : null;
}

/**
 * Whether cancelling ends autopay now or at the end of the paid cycle: a
 * mandate that hasn't charged yet has nothing to finish.
 */
export function cancelsAtCycleEnd(razorpayStatus: string | null): boolean {
  return razorpayStatus === 'active';
}
