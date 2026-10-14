import { describe, expect, it } from 'vitest';

import { digestEmail, digestKey, type Digest } from '@/features/platform/digest';
import {
  activityLine,
  amountWithGst,
  attentionGroupLabel,
  mrrChange,
  type ActivityItem,
} from '@/features/platform/home';
import { readHomeParams } from '@/features/platform/params';

// Stop 12e: Home (docs/DECISIONS.md SA-27 to SA-31).

const item = (overrides: Partial<ActivityItem>): ActivityItem => ({
  key: 'payment:p1',
  kind: 'payment',
  at: '2026-10-14T05:12:00Z',
  restaurant_id: 'r1',
  restaurant_name: 'Sharma Dhaba',
  actor: null,
  data: {},
  ...overrides,
});

describe('activity lines', () => {
  it('a payment, before GST with the GST apart, opens the restaurant’s payments', () => {
    const line = activityLine(
      item({
        actor: 'team@menumesh.in',
        data: { purpose: 'subscription', method: 'upi', base_paise: 89900, gst_paise: 16182 },
      }),
    );
    expect(line).toEqual({
      title: 'Payment received',
      detail: 'UPI, recorded by team@menumesh.in',
      href: '/super/restaurants/r1#section-payments',
      amount: { basePaise: 89900, gstPaise: 16182 },
    });
    expect(amountWithGst(line.amount!)).toBe('₹899 + GST ₹161.82');
  });

  it('a payment without money.view has no amount', () => {
    const line = activityLine(item({ data: { purpose: 'setup_fee', method: 'autopay' } }));
    expect(line.title).toBe('Setup fee received');
    expect(line.amount).toBeNull();
  });

  it('a lead opens on the Leads page and has no restaurant', () => {
    expect(
      activityLine(
        item({
          kind: 'lead',
          restaurant_id: null,
          restaurant_name: null,
          data: { lead_id: 'l1', name: 'Asha', restaurant_name: 'Asha Cafe', city: 'Pune' },
        }),
      ),
    ).toMatchObject({
      title: 'New lead',
      detail: 'Asha, Asha Cafe, Pune',
      href: '/super/leads?lead=l1',
    });
  });

  it('a signup says where it came from', () => {
    expect(
      activityLine(item({ kind: 'signup', data: { city: 'Indore', channel: 'website' } })).detail,
    ).toBe('Indore, Signed up on the website');
  });

  it('what the team did reads in words, with who and why', () => {
    expect(
      activityLine(
        item({
          kind: 'team',
          actor: 'team@menumesh.in',
          data: { action: 'subscription.trial_extended', reason: 'Asked for a week' },
        }),
      ),
    ).toMatchObject({ title: 'Trial extended', detail: 'team@menumesh.in: Asked for a week' });
    expect(activityLine(item({ kind: 'team', data: { action: 'something.new' } })).title).toBe(
      'something.new',
    );
  });

  it('a menu import opens the import', () => {
    expect(
      activityLine(
        item({
          kind: 'menu_import',
          data: {
            import_id: 'i1',
            status: 'imported',
            counts: { categories_created: 1, items_created: 1, items_updated: 3, items_skipped: 0 },
          },
        }),
      ),
    ).toMatchObject({
      title: 'Menu imported',
      detail: '1 dish added, 3 updated',
      href: '/super/restaurants/r1/menu-import/i1',
    });
  });

  it('a lapse says what it was', () => {
    expect(
      activityLine(item({ kind: 'lapsed', data: { day: '2026-10-12', was: 'trial' } })).detail,
    ).toBe('Was Trial');
  });
});

describe('Needs attention headings', () => {
  it('say how long inactive is, from the settings', () => {
    expect(attentionGroupLabel('inactive', 7)).toBe('No orders in 7 days');
    expect(attentionGroupLabel('inactive', 1)).toBe('No orders in 1 day');
    expect(attentionGroupLabel('payment_failed', 7)).toBe('Payment failed');
  });
});

describe('MRR change', () => {
  it('is a whole percentage against a month ago, or nothing to compare', () => {
    expect(mrrChange(108000, 100000)).toBe(8);
    expect(mrrChange(90000, 100000)).toBe(-10);
    expect(mrrChange(100000, null)).toBeNull();
    expect(mrrChange(100000, 0)).toBeNull();
  });
});

describe('Home URL', () => {
  it('reads the period, the activity kind and a cursor, dropping the rest', () => {
    expect(readHomeParams({})).toEqual({ period: 'today', kind: undefined, before: undefined });
    expect(
      readHomeParams({
        period: 'month',
        kind: 'payment',
        before: '2026-10-14T05:12:00Z|payment:p1',
      }),
    ).toEqual({ period: 'month', kind: 'payment', before: '2026-10-14T05:12:00Z|payment:p1' });
    expect(readHomeParams({ period: 'week', kind: 'orders', before: 'nonsense' })).toEqual({
      period: 'today',
      kind: undefined,
      before: undefined,
    });
  });
});

const digest: Digest = {
  day: '2026-10-13',
  states: { mrr_paise: 4218000, paid: 38, trial: 9, payment_failed: 3 },
  collected: { base_paise: 6124000, gst_paise: 1102320, count: 7 },
  signups: 1,
  onboarded: 2,
  leads: 3,
  usage: { gmv_paise: 31000000, orders: 1204 },
  attention: {
    total: 5,
    inactive_days: 14,
    groups: [
      { group: 'payment_failed', count: 3 },
      { group: 'new_leads', count: 2 },
      { group: 'inactive', count: 1 },
    ],
  },
  recipients: ['a@menumesh.in', 'b@menumesh.in'],
};

describe('daily digest email', () => {
  it('has yesterday’s numbers, today’s Needs attention and a link to Home', () => {
    const email = digestEmail(digest, 'https://menumesh.in/');
    expect(email.subject).toBe('MenuMesh on 13 Oct 2026: 5 things need attention');
    expect(email.text).toContain('Yesterday, 13 Oct 2026');
    expect(email.text).toContain(
      'MRR ₹42,180 before GST: 38 paid, 9 trials, 3 with a failed payment.',
    );
    expect(email.text).toContain('Collected ₹61,240 + GST ₹11,023.20 in 7 payments.');
    expect(email.text).toContain('1 signup, 2 onboarded by the team, 3 leads.');
    expect(email.text).toContain('- Payment failed: 3');
    expect(email.text).toContain('- No orders in 14 days: 1');
    expect(email.text).toContain('Home: https://menumesh.in/super');
    expect(email.html).toContain('<a href="https://menumesh.in/super">Open Home</a>');
  });

  it('says when nothing needs attention', () => {
    const quiet = digestEmail(
      { ...digest, attention: { total: 0, inactive_days: 7, groups: [] } },
      'https://x.test',
    );
    expect(quiet.subject).toContain('0 things need attention');
    expect(quiet.text).toContain('Nothing needs attention today.');
  });

  it('is sent once a day to the same people', () => {
    expect(digestKey('2026-10-13', digest.recipients)).toBe(
      digestKey('2026-10-13', digest.recipients),
    );
    expect(digestKey('2026-10-14', digest.recipients)).not.toBe(
      digestKey('2026-10-13', digest.recipients),
    );
    expect(digestKey('2026-10-13', ['a@menumesh.in'])).not.toBe(
      digestKey('2026-10-13', digest.recipients),
    );
  });
});
