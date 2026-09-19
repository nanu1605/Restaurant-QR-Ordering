import { describe, expect, it } from 'vitest';

import { readAuditFilters, readRestaurantFilters } from '@/features/platform/params';
import { formatPeriod, todayInIndia } from '@/features/platform/platform';
import {
  generatePassword,
  manualPaymentSchema,
  onboardSchema,
  periodEnd,
  planFormSchema,
  suggestRestaurantCode,
} from '@/features/platform/schemas';

// Super-admin helpers (spec §13.4, docs/DECISIONS.md P7-4, P7-9).

describe('periodEnd', () => {
  it('ends the day before the same date next month', () => {
    expect(periodEnd('2026-09-01', 'monthly')).toBe('2026-09-30');
    expect(periodEnd('2026-09-15', 'monthly')).toBe('2026-10-14');
  });

  it('crosses the year', () => {
    expect(periodEnd('2026-12-10', 'monthly')).toBe('2027-01-09');
  });

  it('stops at the end of a shorter month', () => {
    expect(periodEnd('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(periodEnd('2028-01-30', 'monthly')).toBe('2028-02-29');
  });

  it('runs a year less a day', () => {
    expect(periodEnd('2026-09-19', 'yearly')).toBe('2027-09-18');
    expect(periodEnd('2028-02-29', 'yearly')).toBe('2029-02-28');
  });
});

describe('formatPeriod', () => {
  it('shows the last day, not the next business day the period ends at', () => {
    expect(formatPeriod('2026-08-31T22:30:00Z', '2026-09-30T22:30:00Z')).toBe(
      '1 Sept 2026 – 30 Sept 2026',
    );
  });

  it('is a dash without dates', () => {
    expect(formatPeriod(null, null)).toBe('—');
  });
});

describe('todayInIndia', () => {
  it('uses India time, not UTC', () => {
    expect(todayInIndia(new Date('2026-09-19T19:00:00Z'))).toBe('2026-09-20');
    expect(todayInIndia(new Date('2026-09-19T18:00:00Z'))).toBe('2026-09-19');
  });
});

describe('suggestRestaurantCode', () => {
  it('turns a name into a code', () => {
    expect(suggestRestaurantCode("Sharma's Dhaba & Grill")).toBe('sharmas-dhaba-grill');
    expect(suggestRestaurantCode('  Café  Mocha 2 ')).toBe('cafe-mocha-2');
  });

  it('keeps codes to 32 characters without a trailing hyphen', () => {
    const code = suggestRestaurantCode('The Very Long Restaurant Name Of Indore City');
    expect(code.length).toBeLessThanOrEqual(32);
    expect(code).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it('gives nothing for names too short to make a code', () => {
    expect(suggestRestaurantCode('A1')).toBe('');
    expect(suggestRestaurantCode('दाल')).toBe('');
  });
});

describe('generatePassword', () => {
  it('makes readable passwords without look-alike characters', () => {
    const password = generatePassword();
    expect(password).toHaveLength(12);
    expect(password).not.toMatch(/[0O1lI]/);
    expect(generatePassword()).not.toBe(password);
  });
});

describe('manualPaymentSchema', () => {
  const valid = {
    amount: '₹899',
    mode: 'upi',
    billingCycle: 'monthly',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    notes: '',
  } as const;

  it('accepts a payment', () => {
    expect(manualPaymentSchema.safeParse(valid).success).toBe(true);
  });

  it('needs a positive amount', () => {
    expect(manualPaymentSchema.safeParse({ ...valid, amount: '0' }).success).toBe(false);
    expect(manualPaymentSchema.safeParse({ ...valid, amount: 'free' }).success).toBe(false);
  });

  it('needs the last day on or after the first', () => {
    const result = manualPaymentSchema.safeParse({ ...valid, periodEnd: '2026-08-31' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['periodEnd']);
    expect(manualPaymentSchema.safeParse({ ...valid, periodEnd: '2026-09-01' }).success).toBe(true);
  });
});

describe('onboardSchema', () => {
  const valid = {
    name: 'Spice Route',
    slug: 'Spice-Route',
    cuisine: 'north_indian',
    legalName: '',
    addressLine: '',
    city: 'Indore',
    state: '',
    pincode: '',
    phone: '',
    email: '',
    ownerName: 'Anita',
    ownerUsername: 'Owner',
    ownerEmail: '',
    ownerPassword: 'long-enough',
    gstMode: 'none',
    gstRateBps: 500,
    pricesIncludeTax: false,
    plan: 'growth',
    trialDays: '14',
  } as const;

  it('normalises the code and username', () => {
    const result = onboardSchema.parse(valid);
    expect(result.slug).toBe('spice-route');
    expect(result.ownerUsername).toBe('owner');
    expect(result.trialDays).toBe(14);
  });

  it('checks what the database would refuse', () => {
    expect(onboardSchema.safeParse({ ...valid, slug: '-bad-' }).success).toBe(false);
    expect(onboardSchema.safeParse({ ...valid, pincode: '012345' }).success).toBe(false);
    expect(onboardSchema.safeParse({ ...valid, gstRateBps: 700 }).success).toBe(false);
    expect(onboardSchema.safeParse({ ...valid, trialDays: '0' }).success).toBe(false);
    expect(onboardSchema.safeParse({ ...valid, ownerPassword: 'short' }).success).toBe(false);
    expect(onboardSchema.safeParse({ ...valid, ownerEmail: 'not-an-email' }).success).toBe(false);
  });
});

describe('planFormSchema', () => {
  const valid = {
    name: 'Growth',
    priceMonthly: '899',
    priceYearly: '8,990',
    maxTables: '',
    maxStaff: '15',
    features: {
      kds: true,
      discounts: true,
      split_payments: true,
      upi_qr_on_bill: true,
      advanced_reports: true,
      waiter_reports: true,
      csv_export: true,
      remove_branding: false,
    },
    razorpayMonthly: 'plan_Growth123',
    razorpayYearly: '',
    isActive: true,
    sortOrder: '2',
  };

  it('accepts empty limits (unlimited) and blank Razorpay ids', () => {
    expect(planFormSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses a zero limit or a Razorpay id with spaces', () => {
    expect(planFormSchema.safeParse({ ...valid, maxStaff: '0' }).success).toBe(false);
    expect(planFormSchema.safeParse({ ...valid, razorpayMonthly: 'plan 1' }).success).toBe(false);
  });
});

describe('list filters from the URL', () => {
  it('keeps known restaurant filters and drops the rest', () => {
    expect(
      readRestaurantFilters({
        q: ' dhaba ',
        status: 'closed',
        subscription: 'past_due',
        plan: 'Growth!',
        from: '2026-09-10',
        to: '2026-09-01',
        sort: 'last_order',
        page: '0',
      }),
    ).toEqual({
      q: 'dhaba',
      status: undefined,
      plan: undefined,
      subscription: 'past_due',
      city: undefined,
      from: '2026-09-10',
      to: undefined,
      sort: 'last_order',
      page: 1,
    });
  });

  it('reads audit filters safely', () => {
    expect(
      readAuditFilters({
        restaurant: 'not-a-uuid',
        actor: 'platform_admin',
        action: 'Restaurant.',
        page: '3',
      }),
    ).toEqual({
      restaurant_id: undefined,
      actor_type: 'platform_admin',
      action: 'restaurant.',
      from: undefined,
      to: undefined,
      page: 3,
    });
    expect(readAuditFilters({ action: 'drop table;' }).action).toBeUndefined();
  });
});
