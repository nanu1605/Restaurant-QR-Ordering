import { describe, expect, it } from 'vitest';

import type { AccessInput } from '@/features/subscriptions/access-banner';
import {
  daysUntil,
  formatPaidPeriod,
  subscriptionSummary,
  type OwnerSubscription,
} from '@/features/subscriptions/summary';

// Owner Subscription page (spec §14.4 step 2, docs/DECISIONS.md P7-21).

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
