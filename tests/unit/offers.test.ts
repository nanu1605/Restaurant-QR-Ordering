import { describe, expect, it } from 'vitest';

import {
  dealPayload,
  dealSchema,
  discountLabel,
  offerPayload,
  offerSchema,
  offerStatus,
  offerTerms,
  overrideLabel,
  overridePayload,
  overrideSchema,
  type OfferRow,
} from '@/features/platform/offers';
import { linkPlanPaise } from '@/features/platform/payment-links';
import { historyLine } from '@/features/platform/restaurant-page';
import { forCycles, specialPrice } from '@/features/subscriptions/offers';

// Stop 14b: offers, deals and overrides (docs/DECISIONS.md SA-77+).

const offer = (patch: Partial<OfferRow> = {}): OfferRow => ({
  id: 'o1',
  code: 'LAUNCH20',
  description: null,
  discount_kind: 'percent',
  discount_value: 20,
  plan_codes: ['growth'],
  cycles: ['monthly'],
  duration_cycles: 3,
  valid_from: '2026-10-01T00:00:00Z',
  valid_until: null,
  max_redemptions: 2,
  new_only: true,
  ended_at: null,
  used: 0,
  discount_paise: 0,
  created_by: null,
  created_at: '2026-10-01T00:00:00Z',
  ...patch,
});

describe('offers', () => {
  const now = new Date('2026-10-15T00:00:00Z');

  it('are live, start later, or ended by hand, by date or when used up', () => {
    expect(offerStatus(offer(), now)).toBe('live');
    expect(offerStatus(offer({ valid_from: '2026-11-01T00:00:00Z' }), now)).toBe('scheduled');
    expect(offerStatus(offer({ ended_at: '2026-10-10T00:00:00Z' }), now)).toBe('ended');
    expect(offerStatus(offer({ valid_until: '2026-10-14T18:30:00Z' }), now)).toBe('ended');
    expect(offerStatus(offer({ used: 2 }), now)).toBe('ended');
  });

  it('say what they take off and for what', () => {
    expect(discountLabel(offer())).toBe('20% off');
    expect(discountLabel(offer({ discount_kind: 'flat', discount_value: 10000 }))).toBe('₹100 off');
    expect(offerTerms(offer(), { growth: 'Growth' })).toBe(
      'Growth, monthly · first 3 charges · new restaurants only',
    );
    expect(
      offerTerms(
        offer({ plan_codes: null, cycles: null, duration_cycles: null, new_only: false }),
        {},
      ),
    ).toBe('Every plan, monthly or yearly · every charge');
  });

  it('are made from the form, the last day ending at India’s midnight', () => {
    const parsed = offerSchema.parse({
      code: ' welcome10 ',
      description: '',
      discountKind: 'flat',
      discount: '₹100',
      planCodes: [],
      cycles: ['yearly'],
      durationCycles: '',
      validFrom: '2026-10-20',
      validUntil: '2026-10-31',
      maxRedemptions: '50',
      newOnly: false,
    });
    expect(offerPayload(parsed)).toEqual({
      code: 'WELCOME10',
      description: null,
      discount_kind: 'flat',
      discount_value: 10000,
      plan_codes: null,
      cycles: ['yearly'],
      duration_cycles: null,
      valid_from: '2026-10-19T18:30:00.000Z',
      valid_until: '2026-10-31T18:30:00.000Z',
      max_redemptions: 50,
      new_only: false,
    });
    const bad = offerSchema.safeParse({ ...parsed, discountKind: 'percent', discount: '100' });
    expect(bad.error?.issues[0]?.path).toEqual(['discount']);
  });
});

describe('a restaurant’s price', () => {
  it('is an offer code, or a price with a reason', () => {
    const base = {
      planCode: 'growth',
      billingCycle: 'monthly',
      offerCode: ' launch20 ',
      price: '',
      cycles: '',
      reason: '',
    } as const;
    expect(dealPayload(dealSchema.parse({ ...base, mode: 'offer' }))).toEqual({
      plan_code: 'growth',
      billing_cycle: 'monthly',
      offer_code: 'LAUNCH20',
    });
    expect(
      dealPayload(
        dealSchema.parse({ ...base, mode: 'custom', price: '699', cycles: '6', reason: 'Chain' }),
      ),
    ).toEqual({
      plan_code: 'growth',
      billing_cycle: 'monthly',
      price_paise: 69900,
      cycles: 6,
      reason: 'Chain',
    });
    expect(dealSchema.safeParse({ ...base, mode: 'custom', price: '699' }).success).toBe(false);
  });

  it('shows on the owner’s cards: the team’s first, then a code’s', () => {
    const deal = {
      plan_code: 'growth',
      billing_cycle: 'yearly' as const,
      list_price_paise: 899000,
      price_paise: 800000,
      cycles: null,
    };
    const preview = {
      code: 'LAUNCH20',
      description: null,
      cycles: 3,
      prices: [{ plan_code: 'growth', billing_cycle: 'monthly' as const, price_paise: 71900 }],
    };
    expect(specialPrice('growth', 'yearly', deal, preview)).toEqual({
      pricePaise: 800000,
      cycles: null,
    });
    expect(specialPrice('growth', 'monthly', deal, preview)).toBeNull();
    expect(specialPrice('growth', 'monthly', null, preview)).toEqual({
      pricePaise: 71900,
      cycles: 3,
    });
    expect(forCycles(3, 'monthly')).toBe('for 3 months');
    expect(forCycles(1, 'yearly')).toBe('for 1 year');
  });

  it('reads in the billing history, with or without its price', () => {
    const entry = (after: Record<string, unknown>) => ({
      at: '2026-10-15T00:00:00Z',
      action: 'subscription.deal_set',
      actor: null,
      before: null,
      after,
      reason: null,
    });
    const plans = { growth: 'Growth' };
    const day = (value: string) => value;
    expect(
      historyLine(
        entry({
          plan_code: 'growth',
          billing_cycle: 'monthly',
          price_paise: 69900,
          offer_code: null,
          cycles: 6,
          applied_now: false,
        }),
        plans,
        day,
      ),
    ).toBe('Price set: ₹699 a month on Growth, for 6 charges, from the next autopay');
    expect(historyLine(entry({ plan_code: 'growth', offer_code: 'LAUNCH20' }), plans, day)).toBe(
      'Price set: on Growth, offer LAUNCH20',
    );
  });
});

describe('overrides', () => {
  it('name a feature, a beta flag or a limit', () => {
    expect(overrideLabel({ kind: 'feature', feature: 'kds', value: null })).toBe('Kitchen view');
    expect(overrideLabel({ kind: 'feature', feature: 'beta_waitlist', value: null })).toBe(
      'Beta: waitlist',
    );
    expect(overrideLabel({ kind: 'max_tables', feature: null, value: 12 })).toBe('Tables: 12');
    expect(overrideLabel({ kind: 'max_staff', feature: null, value: null })).toBe(
      'Staff logins: unlimited',
    );
  });

  it('are made from the form', () => {
    const base = { feature: '', value: '', expiresOn: '', reason: 'Pilot' };
    expect(
      overridePayload(overrideSchema.parse({ ...base, kind: 'max_tables', value: '12' })),
    ).toEqual({ kind: 'max_tables', value: 12, reason: 'Pilot' });
    expect(
      overridePayload(
        overrideSchema.parse({ ...base, kind: 'feature', feature: 'KDS', expiresOn: '2026-12-31' }),
      ),
    ).toEqual({
      kind: 'feature',
      feature: 'kds',
      expires_at: '2026-12-31T18:30:00.000Z',
      reason: 'Pilot',
    });
    expect(overrideSchema.safeParse({ ...base, kind: 'feature', feature: 'no way' }).success).toBe(
      false,
    );
  });
});

describe('linkPlanPaise', () => {
  const deal = {
    monthlyPaise: 60000,
    yearlyPaise: 899000,
    listMonthlyPaise: 89900,
    listYearlyPaise: 899000,
  };

  it('suggests the deal price only for the charges it has left', () => {
    expect(linkPlanPaise({ ...deal, dealChargesLeft: 1 }, 6)).toBe(60000 + 5 * 89900);
    expect(linkPlanPaise({ ...deal, dealChargesLeft: 3 }, 2)).toBe(2 * 60000);
    expect(linkPlanPaise({ ...deal, dealChargesLeft: 0 }, 1)).toBe(89900);
  });

  it('every month when it has no end, and a year for twelve months', () => {
    expect(linkPlanPaise({ ...deal, dealChargesLeft: null }, 6)).toBe(6 * 60000);
    expect(linkPlanPaise({ monthlyPaise: 89900, yearlyPaise: 899000 }, 24)).toBe(2 * 899000);
  });
});
