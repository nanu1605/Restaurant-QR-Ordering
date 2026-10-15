import { describe, expect, it } from 'vitest';

import {
  bucketEnd,
  eachMovement,
  netNewPaise,
  readRevenueParams,
  type RevenuePoint,
  type RevenueReport,
} from '@/features/revenue/revenue';
import { revenueCsv } from '@/features/revenue/revenue-csv';

const today = '2026-10-15';

describe('the Revenue page’s URL', () => {
  it('shows the last 12 months unless dates are chosen', () => {
    expect(readRevenueParams({}, today)).toEqual({
      from: '2025-10-16',
      to: '2026-10-15',
      compare: false,
      by: 'month',
      move: undefined,
      at: undefined,
      notice: null,
    });
  });

  it('reads the movement list, keeping its first day only inside the dates', () => {
    const params = { from: '2026-09-01', to: '2026-09-30', move: 'churn', at: '2026-09-07' };
    expect(readRevenueParams(params, today)).toMatchObject({
      by: 'day',
      move: 'churn',
      at: '2026-09-07',
    });
    expect(readRevenueParams({ ...params, at: '2026-10-01' }, today).at).toBeUndefined();
    expect(readRevenueParams({ ...params, move: 'lost' }, today).move).toBeUndefined();
  });

  it('says so when a date doesn’t exist', () => {
    expect(readRevenueParams({ from: '2026-02-30' }, today)).toMatchObject({
      from: '2025-10-16',
      notice: 'That date doesn’t exist, so the last 12 months are shown.',
    });
  });
});

describe('a bar’s days', () => {
  it('ends on the day, its Sunday or its month’s last day, never after the dates', () => {
    expect(bucketEnd('2026-09-07', 'day', '2026-09-30')).toBe('2026-09-07');
    expect(bucketEnd('2026-09-09', 'week', '2026-09-30')).toBe('2026-09-13');
    expect(bucketEnd('2026-09-28', 'week', '2026-09-30')).toBe('2026-09-30');
    expect(bucketEnd('2026-02-10', 'month', '2026-12-31')).toBe('2026-02-28');
    expect(bucketEnd('2026-01-31', 'month', '2026-12-31')).toBe('2026-01-31');
    expect(bucketEnd('2026-10-01', 'month', '2026-10-15')).toBe('2026-10-15');
  });
});

const moves = (paise: Partial<Record<'new' | 'churn', number>>) =>
  eachMovement((kind) => {
    const value = kind === 'new' || kind === 'churn' ? (paise[kind] ?? 0) : 0;
    return { count: value === 0 ? 0 : 1, paise: value };
  });

describe('movements', () => {
  it('add up to the net new MRR', () => {
    expect(netNewPaise(moves({ new: 89900, churn: -39900 }))).toBe(50000);
  });
});

describe('the CSV', () => {
  const point = (start: string, mrr: number | null): RevenuePoint => ({
    start,
    end: start,
    mrr_paise: mrr,
    paid: mrr === null ? null : 2,
    movements: moves(mrr === null ? {} : { new: 89900, churn: -39900 }),
    subscription_base_paise: 89900,
    setup_fee_base_paise: 49900,
    gst_paise: 25164,
  });

  it('has a row a bar, rupees, and no MRR before history', () => {
    const csv = revenueCsv({
      series: [point('2026-10-01', null), point('2026-10-02', 129800)],
    } as RevenueReport);
    expect(csv.headers.slice(0, 6)).toEqual([
      'First day',
      'Last day',
      'MRR at the end',
      'Paid restaurants at the end',
      'New',
      'New MRR',
    ]);
    expect(csv.headers.at(-4)).toBe('Net new MRR');
    expect(csv.rows[0]).toEqual([
      '2026-10-01',
      '2026-10-01',
      null,
      null,
      ...Array<null>(10).fill(null),
      null,
      '899.00',
      '499.00',
      '251.64',
    ]);
    expect(csv.rows[1]?.slice(2, 6)).toEqual(['1298.00', 2, 1, '899.00']);
    expect(csv.rows[1]?.at(-4)).toBe('500.00');
  });
});
