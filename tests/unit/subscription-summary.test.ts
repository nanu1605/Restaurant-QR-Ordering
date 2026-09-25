import { describe, expect, it } from 'vitest';

import type { AccessInput } from '@/features/subscriptions/access-banner';
import { autopayStartAt, autopayState, cancelsAtCycleEnd } from '@/features/subscriptions/autopay';
import {
  daysUntil,
  formatPaidPeriod,
  subscriptionSummary,
  type OwnerSubscription,
} from '@/features/subscriptions/summary';

// Owner Subscription page (spec §14.3 step 2, docs/DECISIONS.md P7-21, P8-7).

const TZ = 'Asia/Kolkata';
const now = new Date('2026-09-19T06:30:00Z'); // 12:00 in India

const full: AccessInput = { state: 'full', reason: null, restrictionAt: null, warning: null };

function subscription(patch: Partial<OwnerSubscription>): OwnerSubscription {
  return {
    status: 'trialing',
    source: null,
    billingCycle: null,
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    graceUntil: null,
    cancelAtPeriodEnd: false,
    razorpayStatus: null,
    nextPlanName: null,
    nextBillingCycle: null,
    nextPricePaise: null,
    plan: { name: 'Growth', priceMonthlyPaise: 99900, priceYearlyPaise: 999900 },
    ...patch,
  };
}

describe('daysUntil', () => {
  it('rounds part days up and stops at zero', () => {
    expect(daysUntil('2026-09-19T07:30:00Z', now)).toBe(1);
    expect(daysUntil('2026-09-29T06:30:00Z', now)).toBe(10);
    expect(daysUntil('2026-09-18T06:30:00Z', now)).toBe(0);
  });
});

describe('formatPaidPeriod', () => {
  it('shows the last paid day, not the business-day start after it', () => {
    // 1 Oct 04:00 to 1 Nov 04:00 India time.
    expect(formatPaidPeriod('2026-09-30T22:30:00Z', '2026-10-31T22:30:00Z', TZ)).toBe(
      '1 Oct 2026 – 31 Oct 2026',
    );
    expect(formatPaidPeriod(null, '2026-10-31T22:30:00Z', TZ)).toBe('—');
  });
});

describe('subscriptionSummary', () => {
  it('counts down the trial', () => {
    const summary = subscriptionSummary({
      subscription: subscription({ trialEndsAt: '2026-09-29T06:30:00Z' }),
      access: { ...full, restrictionAt: '2026-09-29T22:30:00Z' },
      timezone: TZ,
      now,
    });
    expect(summary).toMatchObject({ label: 'Free trial', tone: 'ok', daysLeft: 10 });
    expect(summary.text).toBe('Your free trial of Growth ends on 29 Sept 2026.');
  });

  it('warns in the last three trial days', () => {
    const summary = subscriptionSummary({
      subscription: subscription({ trialEndsAt: '2026-09-21T06:30:00Z' }),
      access: { ...full, restrictionAt: '2026-09-21T22:30:00Z', warning: 'trial_ends_soon' },
      timezone: TZ,
      now,
    });
    expect(summary).toMatchObject({ label: 'Free trial', tone: 'warning', daysLeft: 2 });
  });

  it('says when ordering stops once the trial is over but access runs to the next business day', () => {
    const summary = subscriptionSummary({
      subscription: subscription({ trialEndsAt: '2026-09-19T05:00:00Z' }),
      access: { ...full, restrictionAt: '2026-09-19T22:30:00Z', warning: 'trial_ends_soon' },
      timezone: TZ,
      now,
    });
    expect(summary).toMatchObject({ label: 'Trial ended', tone: 'warning', daysLeft: 0 });
    expect(summary.text).toContain('Ordering stays on until 20 Sept 2026');
  });

  it('shows the paid period of an active subscription', () => {
    const summary = subscriptionSummary({
      subscription: subscription({
        status: 'active',
        source: 'manual',
        billingCycle: 'monthly',
        currentPeriodStart: '2026-09-18T22:30:00Z',
        currentPeriodEnd: '2026-10-18T22:30:00Z',
      }),
      access: { ...full, restrictionAt: '2026-10-20T22:30:00Z' },
      timezone: TZ,
      now,
    });
    expect(summary).toMatchObject({ label: 'Paid', tone: 'ok', daysLeft: 30 });
    expect(summary.text).toBe('Growth plan, paid until 18 Oct 2026.');
  });

  it('says a cancelled renewal will not renew', () => {
    const summary = subscriptionSummary({
      subscription: subscription({
        status: 'active',
        source: 'razorpay',
        currentPeriodEnd: '2026-09-21T22:30:00Z',
        cancelAtPeriodEnd: true,
      }),
      access: {
        ...full,
        restrictionAt: '2026-09-23T22:30:00Z',
        warning: 'subscription_ends_soon',
      },
      timezone: TZ,
      now,
    });
    expect(summary).toMatchObject({ label: 'Paid', tone: 'warning', daysLeft: 3 });
    expect(summary.text).toContain('It will not renew after that.');
  });

  it('asks for payment after a failed charge', () => {
    const summary = subscriptionSummary({
      subscription: subscription({ status: 'past_due', source: 'razorpay' }),
      access: { ...full, restrictionAt: '2026-09-24T22:30:00Z', warning: 'payment_failed' },
      timezone: TZ,
      now,
    });
    expect(summary).toMatchObject({ label: 'Payment failed', tone: 'warning', daysLeft: 6 });
    expect(summary.text).toBe(
      'The last payment for Growth failed. Pay by 25 Sept 2026 to keep ordering on.',
    );
  });

  it('explains a paused restaurant', () => {
    const lapsed = subscriptionSummary({
      subscription: subscription({ trialEndsAt: '2026-09-01T06:30:00Z' }),
      access: { state: 'read_only', reason: 'trial_ended', restrictionAt: null, warning: null },
      timezone: TZ,
      now,
    });
    expect(lapsed).toMatchObject({ label: 'Trial ended', tone: 'blocked', daysLeft: 0 });

    const suspended = subscriptionSummary({
      subscription: subscription({ status: 'active' }),
      access: { state: 'read_only', reason: 'suspended', restrictionAt: null, warning: null },
      timezone: TZ,
      now,
    });
    expect(suspended).toMatchObject({ label: 'Suspended', tone: 'blocked', daysLeft: null });

    const none = subscriptionSummary({
      subscription: null,
      access: { state: 'read_only', reason: 'no_subscription', restrictionAt: null, warning: null },
      timezone: TZ,
      now,
    });
    expect(none.label).toBe('No plan');
  });
});

describe('autopay', () => {
  it('is on for a set-up or charging mandate, ending once cancelled', () => {
    expect(autopayState(subscription({ razorpayStatus: 'authenticated' }))).toBe('on');
    expect(autopayState(subscription({ razorpayStatus: 'active', cancelAtPeriodEnd: true }))).toBe(
      'ending',
    );
    for (const razorpayStatus of [null, 'created', 'pending', 'halted', 'cancelled']) {
      expect(autopayState(subscription({ razorpayStatus }))).toBe('off');
    }
  });

  it('starts charging when the trial or paid period ends, else now', () => {
    const trial = subscription({ trialEndsAt: '2026-09-29T06:30:00Z' });
    expect(autopayStartAt(trial, now)?.toISOString()).toBe('2026-09-29T06:30:00.000Z');
    const paid = subscription({ status: 'active', currentPeriodEnd: '2026-10-18T22:30:00Z' });
    expect(autopayStartAt(paid, now)?.toISOString()).toBe('2026-10-18T22:30:00.000Z');
    // Minutes away, or over: start now.
    expect(autopayStartAt(subscription({ trialEndsAt: '2026-09-19T06:35:00Z' }), now)).toBeNull();
    expect(
      autopayStartAt(
        subscription({ status: 'past_due', currentPeriodEnd: '2026-10-18T22:30:00Z' }),
        now,
      ),
    ).toBeNull();
  });

  it('cancels a charging subscription at the cycle end, an unused mandate now', () => {
    expect(cancelsAtCycleEnd('active')).toBe(true);
    expect(cancelsAtCycleEnd('authenticated')).toBe(false);
  });

  it('tells a trial owner autopay is set up, without a warning', () => {
    const summary = subscriptionSummary({
      subscription: subscription({
        trialEndsAt: '2026-09-21T06:30:00Z',
        razorpayStatus: 'authenticated',
        nextPlanName: 'Starter',
        nextBillingCycle: 'monthly',
      }),
      access: { ...full, restrictionAt: '2026-09-23T22:30:00Z' },
      timezone: TZ,
      now,
    });
    expect(summary).toMatchObject({ label: 'Free trial', tone: 'ok', daysLeft: 2 });
    expect(summary.text).toBe(
      'Your free trial of Growth ends on 21 Sept 2026. Autopay is set up for Starter, monthly; the first payment is on 21 Sept 2026.',
    );
  });

  it('says Razorpay retries a failed payment', () => {
    const summary = subscriptionSummary({
      subscription: subscription({
        status: 'past_due',
        source: 'razorpay',
        razorpayStatus: 'pending',
      }),
      access: { ...full, restrictionAt: '2026-09-24T22:30:00Z', warning: 'payment_failed' },
      timezone: TZ,
      now,
    });
    expect(summary.text).toContain('Razorpay will try again');
  });

  it('never promises a renewal that nothing will charge', () => {
    const paid = {
      status: 'active' as const,
      source: 'razorpay' as const,
      currentPeriodEnd: '2026-10-18T22:30:00Z',
    };
    const text = (patch: Partial<OwnerSubscription>) =>
      subscriptionSummary({
        subscription: subscription({ ...paid, ...patch }),
        access: { ...full, restrictionAt: '2026-10-20T22:30:00Z' },
        timezone: TZ,
        now,
      }).text;
    expect(text({ razorpayStatus: 'active' })).toContain('It renews automatically.');
    // A replacement checkout was left unfinished: nothing charges.
    expect(text({ razorpayStatus: 'created' })).not.toContain('renews');
    expect(
      text({
        source: 'manual',
        razorpayStatus: 'authenticated',
        nextPlanName: 'Pro',
        nextBillingCycle: 'yearly',
      }),
    ).toContain('Autopay takes over after that for Pro, yearly.');
  });

  it('says the first autopay payment is on its way when the trial ends', () => {
    const summary = subscriptionSummary({
      subscription: subscription({
        trialEndsAt: '2026-09-19T05:00:00Z',
        razorpayStatus: 'authenticated',
      }),
      access: { ...full, restrictionAt: '2026-09-21T22:30:00Z' },
      timezone: TZ,
      now,
    });
    expect(summary).toMatchObject({ label: 'Trial ended', tone: 'ok' });
    expect(summary.text).toContain('The first autopay payment is on its way');
  });
});
