import { DEFAULT_LOCALE } from '@/lib/config';
import type { Database } from '@/types/database';

import type { AccessInput } from './access-banner';

/**
 * What the owner's Subscription page says about the plan (spec §14.4 step 2:
 * current plan, status, trial countdown, payment history). Paying online and
 * choosing a plan come with Razorpay in Phase 8 (docs/DECISIONS.md P7-21).
 */

type Enums = Database['public']['Enums'];

export type OwnerSubscription = {
  status: Enums['subscription_status'];
  source: Enums['subscription_source'] | null;
  billingCycle: Enums['billing_cycle'] | null;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  /** Start of the business day after the last paid day. */
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  cancelAtPeriodEnd: boolean;
  plan: {
    name: string;
    priceMonthlyPaise: number;
    priceYearlyPaise: number;
  };
};

export type SubscriptionPayment = {
  id: string;
  paidAt: string;
  amountPaise: number;
  source: Enums['subscription_payment_source'];
  manualMode: Enums['manual_payment_mode'] | null;
  periodStart: string | null;
  periodEnd: string | null;
};

export type SubscriptionSummary = {
  /** Short status for the badge. */
  label: string;
  tone: 'ok' | 'warning' | 'blocked';
  /** One or two sentences on where the subscription stands. */
  text: string;
  /** Whole days until the trial or paid period ends; null when nothing is running. */
  daysLeft: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cash: 'Cash',
  cheque: 'Cheque',
  razorpay: 'Online (Razorpay)',
  payment_link: 'Payment link',
  manual: 'Recorded by support',
};

export function formatDay(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: timezone,
  }).format(new Date(iso));
}

/** The last day of a period whose end is the start of the next business day. */
export function lastDay(end: string, timezone: string): string {
  return formatDay(new Date(Date.parse(end) - DAY_MS).toISOString(), timezone);
}

export function formatPaidPeriod(
  start: string | null,
  end: string | null,
  timezone: string,
): string {
  if (!start || !end) return '—';
  return `${formatDay(start, timezone)} – ${lastDay(end, timezone)}`;
}

/** Whole days from now until `iso`, rounded up; 0 once it has passed. */
export function daysUntil(iso: string, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now.getTime()) / DAY_MS));
}

export function subscriptionSummary({
  subscription,
  access,
  timezone,
  now = new Date(),
}: {
  subscription: OwnerSubscription | null;
  access: AccessInput;
  timezone: string;
  now?: Date;
}): SubscriptionSummary {
  if (access.reason === 'suspended') {
    return {
      label: 'Suspended',
      tone: 'blocked',
      text: 'This restaurant is suspended, so ordering is paused. Contact support to restore it.',
      daysLeft: null,
    };
  }
  if (!subscription) {
    return {
      label: 'No plan',
      tone: 'blocked',
      text: 'There is no subscription yet. Contact support to choose a plan.',
      daysLeft: null,
    };
  }

  const plan = subscription.plan.name;
  const stopsOn = access.restrictionAt
    ? formatDay(access.restrictionAt, timezone)
    : 'the next business day';

  if (access.state === 'read_only') {
    switch (subscription.status) {
      case 'trialing':
        return {
          label: 'Trial ended',
          tone: 'blocked',
          text: `Your free trial of ${plan} has ended, so ordering is paused. Pay for a plan to start it again.`,
          daysLeft: 0,
        };
      case 'past_due':
      case 'halted':
        return {
          label: 'Payment overdue',
          tone: 'blocked',
          text: 'The payment is overdue, so ordering is paused. Pay to start it again.',
          daysLeft: 0,
        };
      default:
        return {
          label: 'Ended',
          tone: 'blocked',
          text: 'Your subscription has ended, so ordering is paused. Renew to start it again.',
          daysLeft: 0,
        };
    }
  }

  switch (subscription.status) {
    case 'trialing': {
      const left = subscription.trialEndsAt ? daysUntil(subscription.trialEndsAt, now) : null;
      if (left === null) {
        return { label: 'Free trial', tone: 'ok', text: `Free trial of ${plan}.`, daysLeft: null };
      }
      if (left === 0) {
        return {
          label: 'Trial ended',
          tone: 'warning',
          text: `Your free trial of ${plan} has ended. Ordering stays on until ${stopsOn}; pay for a plan before then.`,
          daysLeft: 0,
        };
      }
      return {
        label: 'Free trial',
        tone: left <= 3 ? 'warning' : 'ok',
        text: `Your free trial of ${plan} ends on ${formatDay(subscription.trialEndsAt!, timezone)}.`,
        daysLeft: left,
      };
    }
    case 'active': {
      if (!subscription.currentPeriodEnd) {
        return { label: 'Paid', tone: 'ok', text: `${plan} plan, paid.`, daysLeft: null };
      }
      const left = daysUntil(subscription.currentPeriodEnd, now);
      const until = lastDay(subscription.currentPeriodEnd, timezone);
      if (left === 0) {
        return {
          label: 'Renewal due',
          tone: 'warning',
          text: `Your paid period ended on ${until}. Ordering stays on until ${stopsOn}; renew before then.`,
          daysLeft: 0,
        };
      }
      const next = subscription.cancelAtPeriodEnd
        ? ' It will not renew after that.'
        : subscription.source === 'razorpay'
          ? ' It renews automatically.'
          : '';
      return {
        label: 'Paid',
        tone: subscription.cancelAtPeriodEnd && left <= 3 ? 'warning' : 'ok',
        text: `${plan} plan, paid until ${until}.${next}`,
        daysLeft: left,
      };
    }
    case 'past_due':
    case 'halted':
      return {
        label: 'Payment failed',
        tone: 'warning',
        text: `The last payment for ${plan} failed. Pay by ${stopsOn} to keep ordering on.`,
        daysLeft: access.restrictionAt ? daysUntil(access.restrictionAt, now) : null,
      };
    default:
      return {
        label: 'Cancelled',
        tone: 'warning',
        text: `Your subscription is cancelled. Ordering stays on until ${stopsOn}.`,
        daysLeft: access.restrictionAt ? daysUntil(access.restrictionAt, now) : null,
      };
  }
}
