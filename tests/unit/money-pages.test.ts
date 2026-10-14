import { describe, expect, it } from 'vitest';

import {
  duesMessage,
  formatMobile,
  telHref,
  whatsappHref,
} from '@/features/platform/dues-messages';
import {
  readDuesFilters,
  readPaymentFilters,
  readSubscriptionFilters,
} from '@/features/platform/params';
import { paymentsCsv } from '@/features/platform/payments-csv';
import {
  daysSince,
  daysUntil,
  firstUnpaidDay,
  paymentPlanLabel,
  paymentRecordedBy,
  type DuesRow,
  type PaymentRow,
} from '@/features/platform/platform';
import { toCsv } from '@/features/reports/csv';
import { platformPresets } from '@/lib/date-range';

// Stop 12c: the payments ledger and dues (docs/DECISIONS.md SA-17 to SA-20).

describe('payment filters from the URL', () => {
  const today = '2026-10-14';

  it('shows this month so far by default', () => {
    expect(readPaymentFilters({}, today)).toMatchObject({ from: '2026-10-01', to: today });
  });

  it('shows everything for period=all', () => {
    const filters = readPaymentFilters({ period: 'all' }, today);
    expect(filters.period).toBe('all');
    expect(filters.from).toBeUndefined();
  });

  it('prefers dates to period=all, so the form can narrow it', () => {
    const filters = readPaymentFilters({ period: 'all', from: '2026-09-01' }, today);
    expect(filters.from).toBe('2026-09-01');
    expect(filters.period).toBeUndefined();
  });

  it('drops values the database would refuse', () => {
    expect(
      readPaymentFilters(
        {
          from: '2026-10-10',
          to: '2026-10-01',
          method: 'card',
          purpose: 'gift',
          plan: 'DROP',
          page: '0',
        },
        today,
      ),
    ).toEqual({
      from: '2026-10-10',
      to: undefined,
      q: undefined,
      purpose: undefined,
      method: undefined,
      plan: undefined,
      page: 1,
    });
  });
});

describe('dues and subscription filters', () => {
  it('defaults to failed payments and 30 days', () => {
    expect(readDuesFilters({})).toEqual({
      bucket: 'payment_failed',
      days: 30,
      q: undefined,
      page: 1,
    });
  });

  it('reads a bucket and the 7-day window', () => {
    expect(readDuesFilters({ bucket: 'renewal_due', days: '7' })).toMatchObject({
      bucket: 'renewal_due',
      days: 7,
    });
    expect(readDuesFilters({ bucket: 'overdue', days: '14' })).toMatchObject({
      bucket: 'payment_failed',
      days: 30,
    });
  });

  it('filters subscriptions by state, not Razorpay status', () => {
    expect(readSubscriptionFilters({ state: 'paid' }).state).toBe('paid');
    expect(readSubscriptionFilters({ state: 'active' }).state).toBeUndefined();
  });
});

describe('platformPresets', () => {
  const byKey = (today: string) =>
    Object.fromEntries(platformPresets(today).map((p) => [p.key, [p.from, p.to]]));

  it('works out the calendar ranges', () => {
    expect(byKey('2026-10-14')).toEqual({
      this_month: ['2026-10-01', '2026-10-14'],
      last_month: ['2026-09-01', '2026-09-30'],
      last_30: ['2026-09-15', '2026-10-14'],
      this_quarter: ['2026-10-01', '2026-10-14'],
      last_12_months: ['2025-10-15', '2026-10-14'],
    });
  });

  it('crosses the year in January', () => {
    expect(byKey('2027-01-05')).toMatchObject({
      last_month: ['2026-12-01', '2026-12-31'],
      this_quarter: ['2027-01-01', '2027-01-05'],
    });
  });

  it('starts a quarter on its first month', () => {
    expect(byKey('2026-06-30').this_quarter).toEqual(['2026-04-01', '2026-06-30']);
  });
});

describe('firstUnpaidDay', () => {
  const now = new Date('2026-10-14T06:30:00Z'); // 12:00 in India

  it('follows a running trial or paid period', () => {
    expect(
      firstUnpaidDay(
        { status: 'trialing', restrictionAt: '2026-10-20T00:30:00Z', currentPeriodEnd: null },
        now,
      ),
    ).toBe('2026-10-20');
    expect(
      firstUnpaidDay(
        { status: 'active', restrictionAt: null, currentPeriodEnd: '2026-11-01T00:30:00Z' },
        now,
      ),
    ).toBe('2026-11-01');
  });

  it('is today once nothing runs, or for a failed payment', () => {
    expect(firstUnpaidDay(null, now)).toBe('2026-10-14');
    expect(
      firstUnpaidDay(
        { status: 'past_due', restrictionAt: null, currentPeriodEnd: '2026-11-01T00:30:00Z' },
        now,
      ),
    ).toBe('2026-10-14');
    expect(
      firstUnpaidDay(
        { status: 'active', restrictionAt: null, currentPeriodEnd: '2026-10-01T00:30:00Z' },
        now,
      ),
    ).toBe('2026-10-14');
  });
});

describe('days counts', () => {
  const now = new Date('2026-10-14T06:30:00Z');
  it('rounds days left up and days since down, never below 0', () => {
    expect(daysUntil('2026-10-16T00:00:00Z', now)).toBe(2);
    expect(daysUntil('2026-10-01T00:00:00Z', now)).toBe(0);
    expect(daysSince('2026-10-11T00:00:00Z', now)).toBe(3);
    expect(daysSince('2026-10-20T00:00:00Z', now)).toBe(0);
  });
});

const payment = (overrides: Partial<PaymentRow> = {}): PaymentRow => ({
  payment_id: 'p1',
  created_at: '2026-10-14T05:00:00Z',
  restaurant_id: 'r1',
  restaurant_name: 'Masala, "Corner"',
  slug: 'masala',
  purpose: 'subscription',
  plan_code: 'growth',
  plan_name: 'Growth',
  billing_cycle: 'monthly',
  base_paise: 89900,
  gst_paise: 16182,
  amount_paise: 106082,
  method: 'bank_transfer',
  razorpay_payment_id: null,
  period_start: '2026-10-13T22:30:00Z',
  period_end: '2026-11-13T22:30:00Z',
  recorded_by: 'team@menumesh.test',
  notes: '=UTR 123',
  list_price_paise: null,
  discount_paise: null,
  ...overrides,
});

describe('payment labels', () => {
  it('names the plan and cycle, or the setup fee', () => {
    expect(paymentPlanLabel(payment())).toBe('Growth, monthly');
    expect(paymentPlanLabel(payment({ billing_cycle: 'yearly' }))).toBe('Growth, yearly');
    expect(paymentPlanLabel(payment({ purpose: 'setup_fee', plan_name: null }))).toBe('Setup fee');
    expect(paymentPlanLabel(payment({ plan_name: null }))).toBe('—');
  });

  it('says Razorpay recorded what came through it', () => {
    expect(paymentRecordedBy(payment())).toBe('team@menumesh.test');
    expect(paymentRecordedBy(payment({ method: 'autopay', recorded_by: null }))).toBe('Razorpay');
    expect(paymentRecordedBy(payment({ method: 'cash', recorded_by: null }))).toBe('—');
  });
});

describe('paymentsCsv', () => {
  it('writes the screen columns, rupees and India dates', () => {
    const table = paymentsCsv([payment()]);
    expect(table.headers).toHaveLength(15);
    expect(table.rows[0]).toEqual([
      '2026-10-14 10:30',
      'Masala, "Corner"',
      'masala',
      'Subscription',
      'Growth',
      'Monthly',
      '899.00',
      '161.82',
      '1060.82',
      'Bank transfer',
      null,
      '2026-10-14',
      '2026-11-13',
      'team@menumesh.test',
      '=UTR 123',
    ]);
  });

  it('is escaped like the reports: quotes and formulas', () => {
    const csv = toCsv(paymentsCsv([payment()]));
    expect(csv).toContain('"Masala, ""Corner"""');
    expect(csv).toContain(",'=UTR 123");
  });

  it('leaves a setup fee without plan or period', () => {
    const row = paymentsCsv([
      payment({
        purpose: 'setup_fee',
        plan_name: null,
        billing_cycle: null,
        period_start: null,
        period_end: null,
      }),
    ]).rows[0]!;
    expect(row.slice(3, 6)).toEqual(['Setup fee', null, null]);
    expect(row.slice(11, 13)).toEqual([null, null]);
  });
});

const due = (overrides: Partial<DuesRow> = {}): DuesRow => ({
  restaurant_id: 'r1',
  name: 'Masala Corner',
  slug: 'masala',
  city: 'Indore',
  phone: '9876543210',
  plan_code: 'growth',
  plan_name: 'Growth',
  billing_cycle: 'monthly',
  status: 'past_due',
  source: 'razorpay',
  state: 'payment_failed',
  trial_ends_at: '2026-10-16T06:30:00Z',
  current_period_end: '2026-11-13T22:30:00Z',
  grace_until: '2026-10-18T06:30:00Z',
  restriction_at: null,
  access_reason: null,
  razorpay_status: 'pending',
  autopay: false,
  renewal_kind: 'ending',
  due_paise: 106082,
  last_reminder_kind: null,
  last_reminder_at: null,
  ...overrides,
});

describe('dues messages', () => {
  it('fills in the restaurant, plan, amount and day', () => {
    const text = duesMessage('payment_failed', due(), 'en');
    expect(text).toContain('Masala Corner');
    expect(text).toContain('Growth');
    expect(text).toContain('₹1,060.82');
    expect(text).toContain('18 October');
  });

  it('gives the last paid day for a renewal', () => {
    expect(duesMessage('renewal_due', due(), 'en')).toContain('paid till 13 November');
  });

  it('says the cycle on a trial', () => {
    expect(duesMessage('trial_ending', due({ billing_cycle: null }), 'en')).toContain('a month');
    expect(duesMessage('trial_ending', due({ billing_cycle: 'yearly' }), 'hi')).toContain(
      'प्रति वर्ष',
    );
  });

  it('writes Hindi in NFC with Hindi month names', () => {
    for (const bucket of ['payment_failed', 'lapsed', 'trial_ending', 'renewal_due'] as const) {
      const text = duesMessage(bucket, due(), 'hi');
      expect(text).toBe(text.normalize('NFC'));
      expect(text).toContain('Masala Corner');
      expect(text).not.toMatch(/\$\{|undefined/);
    }
    // The month is in Hindi words (ICU spells it), not English.
    expect(duesMessage('payment_failed', due(), 'hi')).toMatch(/18 \p{Script=Devanagari}+ तक/u);
  });

  it('opens WhatsApp and the phone only for a mobile number', () => {
    expect(whatsappHref('9876543210', 'Hi & bye')).toBe(
      'https://wa.me/919876543210?text=Hi%20%26%20bye',
    );
    expect(telHref('9876543210')).toBe('tel:+919876543210');
    expect(whatsappHref('12345', 'Hi')).toBeNull();
    expect(telHref(null)).toBeNull();
  });

  it('reads a mobile stored with +91, spaces or dashes', () => {
    expect(telHref('+91 98765-43210')).toBe('tel:+919876543210');
    expect(whatsappHref('098765 43210', '')).toBe('https://wa.me/919876543210?text=');
    expect(formatMobile('+91-9876543210')).toBe('98765 43210');
    expect(formatMobile('022 2345 6789')).toBeNull();
  });
});
