import { describe, expect, it } from 'vitest';

import { activityKindsFor, activityLine, type ActivityItem } from '@/features/platform/home';
import { readActivityParams, readRestaurantFilters } from '@/features/platform/params';
import {
  historyLine,
  limitHitLabel,
  linkLabel,
  noteSchema,
  qrShare,
  RESTAURANT_TABS,
  type HistoryEntry,
} from '@/features/platform/restaurant-page';

// Stop 13a: a restaurant's page (docs/DECISIONS.md SA-33 to SA-39).

const UUID = '0b8e3f0e-6a4c-4b7d-9a51-5f2a8c1d2e3f';

describe('QR orders', () => {
  it('shows the share with its fraction', () => {
    expect(qrShare(430, 182)).toBe('70% (430 of 612)');
  });

  it('shows only the fraction below 5 orders', () => {
    expect(qrShare(2, 1)).toBe('2 of 3');
  });

  it('is empty without orders', () => {
    expect(qrShare(0, 0)).toBeNull();
  });
});

describe('subscription history', () => {
  const entry = (overrides: Partial<HistoryEntry>): HistoryEntry => ({
    at: '2026-10-14T05:00:00Z',
    action: 'subscription.plan_changed',
    actor: 'team@menumesh.in',
    before: null,
    after: null,
    reason: null,
    ...overrides,
  });
  const plans = { starter: 'Starter', growth: 'Growth' };
  const date = (value: string) => value.slice(0, 10);

  it('names the plans a change went between', () => {
    expect(
      historyLine(
        entry({ before: { plan_code: 'starter' }, after: { plan_code: 'growth' } }),
        plans,
        date,
      ),
    ).toBe('Plan changed from Starter to Growth');
  });

  it('says how long a trial was extended and to when', () => {
    expect(
      historyLine(
        entry({
          action: 'subscription.trial_extended',
          after: { days: 7, trial_ends_at: '2026-11-01T10:00:00Z' },
        }),
        plans,
        date,
      ),
    ).toBe('Trial extended by 7 days, to 2026-11-01');
  });

  it('gives the reason for leaving', () => {
    expect(
      historyLine(
        entry({
          action: 'subscription.cancel_reason',
          after: { reason: 'too_expensive', detail: 'Wants a discount' },
        }),
        plans,
        date,
      ),
    ).toBe('Reason for leaving: Too expensive (Wants a discount)');
  });

  it('reads a Razorpay status change', () => {
    expect(
      historyLine(
        entry({
          action: 'subscription.razorpay_updated',
          before: { status: 'active' },
          after: { status: 'past_due' },
        }),
        plans,
        date,
      ),
    ).toBe('Razorpay: Active to Payment failed');
  });
});

describe('payment links and plan limits', () => {
  const link = {
    at: '2026-10-14T05:00:00Z',
    actor: null,
    purpose: 'subscription',
    months: 3,
    amount_paise: 318246,
    short_url: null,
    paid_at: null,
  };

  it('says what a link asked for', () => {
    expect(linkLabel(link)).toBe('3 months, ₹3,182.46');
    expect(linkLabel({ ...link, purpose: 'setup_fee', months: null, amount_paise: null })).toBe(
      'Setup fee',
    );
  });

  it('names the limit a restaurant ran into', () => {
    const hit = { kind: 'feature' as const, feature: 'kds', count: 2, last_at: '' };
    expect(limitHitLabel(hit)).toBe('Kitchen view, not in the plan');
    expect(limitHitLabel({ ...hit, kind: 'tables', feature: null })).toBe(
      'More tables than the plan allows',
    );
  });
});

describe('notes', () => {
  const item: ActivityItem = {
    key: 'note:n1',
    kind: 'note',
    at: '2026-10-14T05:12:00Z',
    restaurant_id: 'r1',
    restaurant_name: 'Sharma Dhaba',
    actor: 'team@menumesh.in',
    data: { note_id: 'n1', body: 'Prefers calls after 4 pm', more: false, pinned: true },
  };

  it('reads as a note and opens the restaurant’s notes', () => {
    expect(activityLine(item)).toEqual({
      title: 'Pinned note',
      detail: 'Prefers calls after 4 pm',
      href: '/super/restaurants/r1/notes',
      amount: null,
    });
  });

  it('marks a note cut short', () => {
    expect(activityLine({ ...item, data: { ...item.data, more: true, pinned: false } })).toEqual(
      expect.objectContaining({ title: 'Note', detail: 'Prefers calls after 4 pm…' }),
    );
  });

  it('must say something, up to 2,000 characters', () => {
    expect(noteSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(noteSchema.safeParse({ body: 'x'.repeat(2001) }).success).toBe(false);
    expect(noteSchema.parse({ body: '  Call after 4 pm ' })).toEqual({ body: 'Call after 4 pm' });
  });
});

describe('the restaurant page', () => {
  it('has its tabs in order, Overview first', () => {
    expect(RESTAURANT_TABS.map((tab) => tab.label)).toEqual([
      'Overview',
      'Billing',
      'Usage',
      'Activity',
      'Notes',
      'Documents',
      'Support view',
      'Menu imports',
    ]);
  });

  it('shows the kinds an admin may see', () => {
    expect(activityKindsFor({ money: false, growth: false, audit: false })).toEqual([
      'signup',
      'onboarded',
      'lapsed',
      'reminder',
      'menu_import',
      'note',
    ]);
  });

  it('reads the timeline’s kind and page from the URL', () => {
    expect(readActivityParams({ kind: 'note', before: '2026-10-14T05:12:00Z|note:n1' })).toEqual({
      kind: 'note',
      before: '2026-10-14T05:12:00Z|note:n1',
    });
    expect(readActivityParams({ kind: 'orders', before: 'soon' })).toEqual({
      kind: undefined,
      before: undefined,
    });
  });

  it('filters the list by tag and account manager', () => {
    expect(readRestaurantFilters({ tag: UUID, manager: 'me' })).toMatchObject({
      tag: UUID,
      manager: 'me',
    });
    expect(readRestaurantFilters({ manager: 'none' }).manager).toBe('none');
    expect(readRestaurantFilters({ manager: UUID }).manager).toBe(UUID);
    expect(readRestaurantFilters({ tag: 'pilot', manager: 'someone' })).toMatchObject({
      tag: undefined,
      manager: undefined,
    });
  });
});
