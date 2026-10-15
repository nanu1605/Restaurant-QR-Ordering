import { describe, expect, it } from 'vitest';

import {
  businessTodayInIndia,
  changeNote,
  defaultSeriesBy,
  groupSeries,
  percent,
  previousPeriodLabel,
  rankGroups,
  readUsageParams,
} from '@/features/usage/usage';

const day = (date: string, gmv: number, orders: number) => ({
  day: date,
  gmv_paise: gmv,
  orders,
});

describe('usage over time', () => {
  it('fills missing days with zero', () => {
    expect(
      groupSeries([day('2026-10-02', 500, 2)], '2026-10-01', '2026-10-03', 'day').map((p) => [
        p.start,
        p.gmvPaise,
        p.orders,
      ]),
    ).toEqual([
      ['2026-10-01', 0, 0],
      ['2026-10-02', 500, 2],
      ['2026-10-03', 0, 0],
    ]);
  });

  it('sums weeks from Monday, the first one starting on the first date', () => {
    // 1 Oct 2026 is a Thursday; Monday 5 Oct starts the next week.
    const weeks = groupSeries(
      [day('2026-10-01', 100, 1), day('2026-10-04', 200, 2), day('2026-10-05', 400, 4)],
      '2026-10-01',
      '2026-10-12',
      'week',
    );
    expect(weeks.map((p) => [p.start, p.gmvPaise, p.orders])).toEqual([
      ['2026-10-01', 300, 3],
      ['2026-10-05', 400, 4],
      ['2026-10-12', 0, 0],
    ]);
  });

  it('sums calendar months', () => {
    const months = groupSeries(
      [day('2026-01-31', 100, 1), day('2026-02-01', 200, 2), day('2026-03-15', 400, 4)],
      '2026-01-15',
      '2026-03-15',
      'month',
    );
    expect(months.map((p) => [p.start, p.gmvPaise])).toEqual([
      ['2026-01-15', 100],
      ['2026-02-01', 200],
      ['2026-03-01', 400],
    ]);
  });

  it('shows days for a month, weeks to about six months, months beyond', () => {
    expect(defaultSeriesBy('2026-10-01', '2026-10-31')).toBe('day');
    expect(defaultSeriesBy('2026-10-01', '2026-11-01')).toBe('week');
    expect(defaultSeriesBy('2026-01-01', '2026-07-02')).toBe('week');
    expect(defaultSeriesBy('2025-10-16', '2026-10-15')).toBe('month');
  });
});

describe('comparing periods', () => {
  it('gives the change as a percentage, honest below 5', () => {
    const period = previousPeriodLabel(30);
    expect(period).toBe('the previous 30 days');
    expect(changeNote(120, 100, period)).toEqual({
      direction: 'up',
      text: 'Up 20% on the previous 30 days',
    });
    expect(changeNote(50, 100, period)).toEqual({
      direction: 'down',
      text: 'Down 50% on the previous 30 days',
    });
    expect(changeNote(100, 100, period).text).toBe('Same as the previous 30 days');
    expect(changeNote(9, 3, period)).toEqual({
      direction: null,
      text: '3 in the previous 30 days',
    });
    expect(changeNote(4, 0, previousPeriodLabel(1)).text).toBe('None in the day before');
  });

  it('shows a share as a whole percentage, a part never as 0%', () => {
    expect(percent(1, 3)).toBe('33%');
    expect(percent(1, 1000)).toBe('under 1%');
    expect(percent(0, 1000)).toBe('0%');
    expect(percent(0, 0)).toBe('—');
  });
});

describe('the page’s URL', () => {
  const today = '2026-10-15';

  it('shows the last 30 days unless dates are chosen', () => {
    expect(readUsageParams({}, today)).toEqual({
      from: '2026-09-16',
      to: '2026-10-15',
      compare: false,
      by: 'day',
      rank: 'gmv',
      notice: null,
    });
  });

  it('reads compare, grouping and ranking, ignoring the unknown', () => {
    const params = readUsageParams(
      { from: '2026-01-01', to: '2026-06-30', compare: '1', by: 'month', rank: 'restaurants' },
      today,
    );
    expect(params).toMatchObject({ compare: true, by: 'month', rank: 'restaurants' });
    expect(readUsageParams({ by: 'year', rank: 'x', compare: 'yes' }, today)).toMatchObject({
      compare: false,
      by: 'day',
      rank: 'gmv',
    });
  });

  it('says so when a date doesn’t exist', () => {
    expect(readUsageParams({ from: '2026-02-30' }, today)).toMatchObject({
      from: '2026-09-16',
      notice: 'That date doesn’t exist, so the last 30 days are shown.',
    });
  });

  it('starts the business day at 4 am in India', () => {
    expect(businessTodayInIndia(new Date('2026-10-15T22:00:00Z'))).toBe('2026-10-15'); // 3:30 am IST on the 16th
    expect(businessTodayInIndia(new Date('2026-10-15T22:30:00Z'))).toBe('2026-10-16'); // 4 am IST
  });

  it('ranks places by restaurants when asked', () => {
    const groups = [
      { name: 'A', restaurants: 1, active: 1, orders: 9, gmv_paise: 900 },
      { name: 'B', restaurants: 3, active: 1, orders: 1, gmv_paise: 100 },
    ];
    expect(rankGroups(groups, 'gmv').map((g) => g.name)).toEqual(['A', 'B']);
    expect(rankGroups(groups, 'restaurants').map((g) => g.name)).toEqual(['B', 'A']);
  });
});
