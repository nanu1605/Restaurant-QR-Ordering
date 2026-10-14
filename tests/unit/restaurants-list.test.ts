import { describe, expect, it } from 'vitest';

import {
  readRestaurantColumns,
  readRestaurantFilters,
  restaurantParams,
} from '@/features/platform/params';
import {
  DEFAULT_RESTAURANT_COLUMNS,
  parseSearchResults,
  type RestaurantRow,
} from '@/features/platform/platform';
import { paidTillDay, restaurantsCsv } from '@/features/platform/restaurants-csv';

// Stop 12d: the restaurants list, columns, CSV and search (docs/DECISIONS.md SA-22 to SA-25).

describe('restaurant filters from the URL', () => {
  it('keeps known filters and drops the rest', () => {
    expect(
      readRestaurantFilters({
        q: ' dhaba ',
        state: 'payment_failed',
        plan: 'Growth!',
        health: 'sleepy',
        channel: 'unknown',
        city: 'Pune',
        from: '2026-09-10',
        to: '2026-09-01',
        paid_from: '2026-10-01',
        paid_to: '2026-10-31',
        sort: 'gmv',
        dir: 'sideways',
        page: '0',
      }),
    ).toEqual({
      q: 'dhaba',
      state: 'payment_failed',
      plan: undefined,
      health: undefined,
      city: 'Pune',
      region: undefined,
      channel: 'unknown',
      from: '2026-09-10',
      to: undefined,
      paid_from: '2026-10-01',
      paid_to: '2026-10-31',
      sort: 'gmv',
      dir: undefined,
      page: 1,
    });
  });

  it('drops the old status and subscription filters', () => {
    expect(readRestaurantFilters({ status: 'suspended', subscription: 'past_due' })).toEqual(
      readRestaurantFilters({}),
    );
  });
});

describe('restaurant columns', () => {
  it('shows the default set when none or only unknown ones are chosen', () => {
    expect(readRestaurantColumns({})).toEqual(DEFAULT_RESTAURANT_COLUMNS);
    expect(readRestaurantColumns({ cols: 'secret' })).toEqual(DEFAULT_RESTAURANT_COLUMNS);
    expect(DEFAULT_RESTAURANT_COLUMNS).not.toContain('channel');
  });

  it('reads a comma list or one value per checkbox, in the list order', () => {
    expect(readRestaurantColumns({ cols: 'phone,state' })).toEqual(['state', 'phone']);
    expect(readRestaurantColumns({ cols: ['gmv', 'channel'] })).toEqual(['gmv', 'channel']);
  });

  it('puts columns in the URL only when they are not the default', () => {
    const filters = readRestaurantFilters({ state: 'paid', page: '2' });
    expect(restaurantParams(filters, DEFAULT_RESTAURANT_COLUMNS)).toEqual({
      state: 'paid',
      page: '2',
      cols: undefined,
    });
    expect(restaurantParams({ ...filters, page: 1 }, ['state', 'phone'])).toEqual({
      state: 'paid',
      cols: 'state,phone',
    });
  });
});

const row: RestaurantRow = {
  restaurant_id: 'r1',
  name: 'Sharma, "Dhaba"',
  slug: 'sharma-dhaba',
  city: 'Pune',
  region: 'Maharashtra',
  phone: '9876543210',
  status: 'active',
  created_at: '2026-09-30T20:00:00Z',
  acquisition_channel: null,
  plan_code: 'growth',
  plan_name: 'Growth',
  billing_cycle: 'monthly',
  subscription_status: 'active',
  state: 'paid',
  access_state: 'full',
  // The period ends at the start of 1 Nov (India), so it is paid till 31 Oct.
  paid_till: '2026-10-31T18:30:00Z',
  ending: false,
  health: 'slowing',
  last_active: null,
  gmv_30d_paise: 1234550,
  orders_7d: [3, 0, 5, 2, 0, 1, 4],
  paid: { subscription_paise: 99900, setup_fee_paise: 50000, gst_paise: 26982 },
  tags: [
    { id: 't1', name: 'Pilot', colour: 'orange' },
    { id: 't2', name: 'Indore', colour: 'teal' },
  ],
  account_manager: 'tanishq@menumesh.test',
  onboarding: { done: 7, next: null, since: '2026-10-02T06:00:00Z', stuck: false },
};

describe('paid till', () => {
  it('is the last day of a paid period', () => {
    expect(paidTillDay(row)).toBe('2026-10-31');
  });

  it('is the day a trial ends', () => {
    expect(
      paidTillDay({ subscription_status: 'trialing', paid_till: '2026-10-20T10:00:00Z' }),
    ).toBe('2026-10-20');
  });

  it('is empty without a subscription', () => {
    expect(paidTillDay({ subscription_status: null, paid_till: null })).toBeNull();
  });
});

describe('restaurants CSV', () => {
  it('writes every column, in rupees, with the GST apart', () => {
    const csv = restaurantsCsv([row]);
    expect(csv.headers).toHaveLength(20);
    expect(csv.rows[0]).toEqual([
      'Sharma, "Dhaba"',
      'sharma-dhaba',
      'Pune',
      'Maharashtra',
      '9876543210',
      'Paid',
      'Growth',
      'Monthly',
      '2026-10-31',
      '999.00',
      '500.00',
      '269.82',
      '12345.50',
      15,
      'Slowing',
      null,
      null,
      'Pilot, Indore',
      'tanishq@menumesh.test',
      '2026-10-01',
    ]);
  });
});

describe('restaurants CSV without money.view', () => {
  it('leaves out what was paid', () => {
    const csv = restaurantsCsv([{ ...row, paid: null }], false);
    expect(csv.headers).toHaveLength(17);
    expect(csv.headers).not.toContain('GST paid');
    expect(csv.rows[0]).toHaveLength(17);
    expect(csv.rows[0]?.[9]).toBe('12345.50');
  });
});

describe('search results', () => {
  it('reads the three groups', () => {
    const results = parseSearchResults({
      restaurants: [
        {
          restaurant_id: 'r1',
          name: 'Sharma Dhaba',
          slug: 'sharma-dhaba',
          city: 'Pune',
          match: 'Phone 98765 43210',
        },
      ],
      payments: [],
      leads: [],
    });
    expect(results.restaurants[0]?.match).toBe('Phone 98765 43210');
    expect(results.leads).toEqual([]);
  });
});
