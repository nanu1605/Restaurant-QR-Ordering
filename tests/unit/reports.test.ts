import { describe, expect, it } from 'vitest';

import {
  activityCsv,
  csvDateTime,
  itemsCsv,
  paiseToRupees,
  salesCsv,
  toCsv,
} from '@/features/reports/csv';
import { exportHref, readReportParams, reportHref } from '@/features/reports/params';
import {
  compactINR,
  hourLabel,
  hourOrder,
  minutesLabel,
  parseActivityReport,
  parseSalesReport,
  parseWaiterReport,
} from '@/features/reports/report';
import { addDays, datePresets, readDateRange } from '@/lib/date-range';

describe('date ranges', () => {
  it('builds presets from the business day', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(datePresets('2026-09-03').map((p) => `${p.key} ${p.from}..${p.to}`)).toEqual([
      'today 2026-09-03..2026-09-03',
      'yesterday 2026-09-02..2026-09-02',
      'week 2026-08-28..2026-09-03',
      'month 2026-09-01..2026-09-03',
    ]);
  });

  it('names the page in the shortened-range notice', () => {
    expect(readDateRange({ from: '2025-04-01', to: '2026-09-18' }, 'Reports')).toEqual({
      range: { from: '2025-04-01', to: '2026-04-02' },
      notice: 'Reports shows up to a year at a time, so the range was shortened.',
    });
    expect(readDateRange({ from: '2026-02-30' }, 'Reports').notice).toBe(
      'That date doesn’t exist, so today is shown.',
    );
  });
});

describe('readReportParams', () => {
  it('defaults to the sales report for today', () => {
    expect(readReportParams({})).toEqual({
      report: 'sales',
      range: {},
      kind: 'voids_discounts',
      page: 1,
      notice: null,
    });
  });

  it('reads the report, activity kind, range and page', () => {
    expect(
      readReportParams({
        report: 'activity',
        kind: 'removed_items',
        from: '2026-09-01',
        to: '2026-09-17',
        page: '3',
      }),
    ).toEqual({
      report: 'activity',
      range: { from: '2026-09-01', to: '2026-09-17' },
      kind: 'removed_items',
      page: 3,
      notice: null,
    });
  });

  it('falls back when the report, kind or page is not one of ours', () => {
    const params = readReportParams({ report: 'profits', kind: 'secrets', page: '0' });
    expect(params).toMatchObject({ report: 'sales', kind: 'voids_discounts', page: 1 });
  });
});

describe('report links', () => {
  const current = readReportParams({
    report: 'activity',
    kind: 'removed_items',
    from: '2026-09-01',
    to: '2026-09-17',
    page: '2',
  });

  it('keeps the range when switching report, and resets the page', () => {
    expect(reportHref(current, { report: 'items' })).toBe(
      '/admin/reports?report=items&from=2026-09-01&to=2026-09-17',
    );
    expect(reportHref(current, { page: 3 })).toBe(
      '/admin/reports?report=activity&from=2026-09-01&to=2026-09-17&kind=removed_items&page=3',
    );
  });

  it('leaves out the defaults', () => {
    expect(reportHref(readReportParams({}), { from: '2026-09-18', to: '2026-09-18' })).toBe(
      '/admin/reports?from=2026-09-18&to=2026-09-18',
    );
  });

  it('builds export links', () => {
    expect(exportHref('items', { from: '2026-09-01', to: '2026-09-17' })).toBe(
      '/admin/reports/export?report=items&from=2026-09-01&to=2026-09-17',
    );
    expect(exportHref('activity', {}, 'deleted_orders')).toBe(
      '/admin/reports/export?report=activity&kind=deleted_orders',
    );
  });
});

describe('labels', () => {
  it('orders the heatmap hours from the business day start', () => {
    expect(hourOrder(4).slice(0, 3)).toEqual([4, 5, 6]);
    expect(hourOrder(4).at(-1)).toBe(3);
    expect(hourOrder(0)[0]).toBe(0);
  });

  it('writes hours and durations the way a manager reads them', () => {
    expect(hourLabel(0)).toBe('12 am');
    expect(hourLabel(13)).toBe('1 pm');
    expect(minutesLabel(45)).toBe('45 m');
    expect(minutesLabel(60)).toBe('1 h');
    expect(minutesLabel(135)).toBe('2 h 15 m');
  });

  it('shortens money for chart axes with Indian numbering', () => {
    expect(compactINR(95_000)).toBe('₹950');
    expect(compactINR(12_50_000)).toBe('₹12.5K');
    expect(compactINR(1_00_00_000)).toBe('₹1L');
  });
});

const salesJson = {
  today: '2026-09-18',
  from: '2026-09-17',
  to: '2026-09-18',
  start_hour: 4,
  basic: false,
  summary: {
    bills: 2,
    gross_paise: 80000,
    discount_paise: 5000,
    service_charge_paise: 1500,
    tax_paise: 3750,
    round_off_paise: 0,
    net_paise: 75000,
    total_paise: 78750,
    average_paise: 39375,
    unpaid_bills: 1,
    unpaid_paise: 31500,
    collected: { cash: 20000, upi: 27250, card: 0, other: 0 },
  },
  days: [
    {
      date: '2026-09-17',
      bills: 2,
      gross_paise: 80000,
      discount_paise: 5000,
      service_charge_paise: 1500,
      tax_paise: 3750,
      round_off_paise: 0,
      net_paise: 75000,
      total_paise: 78750,
      average_paise: 39375,
      unpaid_bills: 1,
      unpaid_paise: 31500,
      collected: { cash: 20000, upi: 27250, card: 0, other: 0 },
    },
  ],
  hours: [{ weekday: 4, hour: 13, bills: 2, total_paise: 78750 }],
};

describe('parsers', () => {
  it('reads the sales report', () => {
    const report = parseSalesReport(salesJson);
    expect(report.summary.netPaise).toBe(75000);
    expect(report.summary.collected?.upi).toBe(27250);
    expect(report.days?.[0]).toMatchObject({ date: '2026-09-17', totalPaise: 78750 });
    expect(report.hours?.[0]).toEqual({ weekday: 4, hour: 13, bills: 2, totalPaise: 78750 });
  });

  it('reads a Starter summary without payment modes', () => {
    const report = parseSalesReport({
      ...salesJson,
      basic: true,
      summary: { ...salesJson.summary, collected: null },
      days: null,
      hours: null,
    });
    expect(report.basic).toBe(true);
    expect(report.summary.collected).toBeNull();
    expect(report.days).toBeNull();
  });

  it('reads the waiter report', () => {
    const report = parseWaiterReport({
      today: '2026-09-18',
      from: '2026-09-18',
      to: '2026-09-18',
      waiters: [
        {
          waiter_id: 'w1',
          name: 'Ravi',
          is_active: true,
          on_duty: true,
          tables: 3,
          sales_paise: 120000,
          minutes: 62,
          rounds: 5,
          items: 11,
          open_tables: 1,
        },
      ],
      days: [{ date: '2026-09-18', waiter_id: 'w1', tables: 3 }],
    });
    expect(report.waiters[0]).toMatchObject({ name: 'Ravi', tables: 3, openTables: 1 });
    expect(report.days[0]).toEqual({ date: '2026-09-18', waiterId: 'w1', tables: 3 });
  });

  it('reads each kind of activity row', () => {
    const removed = parseActivityReport({
      today: '2026-09-18',
      from: '2026-09-18',
      to: '2026-09-18',
      kind: 'removed_items',
      page: 1,
      page_size: 50,
      total: 1,
      rows: [
        {
          at: '2026-09-18T14:00:00+05:30',
          name: 'Paneer Tikka',
          variant: null,
          quantity: 1,
          was_served: true,
          value_paise: 28000,
          table_label: '5',
          round_number: 1,
          actor_name: 'Priya',
          actor_role: 'manager',
          reason: 'Spilled',
        },
      ],
    });
    expect(removed.kind).toBe('removed_items');
    expect(removed.rows[0]).toMatchObject({ wasServed: true, valuePaise: 28000, tableLabel: '5' });
  });
});

describe('csv', () => {
  it('writes rupees with two decimals', () => {
    expect(paiseToRupees(66250)).toBe('662.50');
    expect(paiseToRupees(0)).toBe('0.00');
    expect(paiseToRupees(-50)).toBe('-0.50');
    expect(paiseToRupees(100)).toBe('1.00');
  });

  it('quotes commas, quotes and newlines, and defuses formulas', () => {
    const csv = toCsv({
      headers: ['Dish', 'Reason'],
      rows: [
        ['Paneer, Tikka', 'He said "no"'],
        ['=HYPERLINK("http://x")', 'line\nbreak'],
        ['@sum', null],
      ],
    });
    expect(csv.startsWith('﻿Dish,Reason\r\n')).toBe(true);
    expect(csv).toContain('"Paneer, Tikka","He said ""no"""');
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")","line\nbreak"`);
    expect(csv).toContain(`'@sum,`);
  });

  it('keeps a negative round off a number a spreadsheet can add up', () => {
    const report = parseSalesReport({
      ...salesJson,
      days: [{ ...salesJson.days[0], round_off_paise: -50 }],
    });
    const csv = toCsv(salesCsv(report));
    expect(csv).toContain(',-0.50,');
    expect(csv).not.toContain("'-0.50");
    // Text that starts with a minus is still defused.
    expect(toCsv({ headers: ['Reason'], rows: [['-1+2']] })).toContain("'-1+2");
  });

  it('writes the sales day rows', () => {
    const table = salesCsv(parseSalesReport(salesJson));
    expect(table.headers[0]).toBe('Date');
    expect(table.rows[0]).toEqual([
      '2026-09-17',
      2,
      '800.00',
      '50.00',
      '15.00',
      '37.50',
      '0.00',
      '750.00',
      '787.50',
      '393.75',
      '200.00',
      '272.50',
      '0.00',
      '0.00',
      1,
    ]);
  });

  it('writes dish rows', () => {
    const table = itemsCsv({
      today: '2026-09-18',
      from: '2026-09-18',
      to: '2026-09-18',
      items: [
        {
          menuItemId: 'm1',
          variantId: 'v1',
          name: 'Butter Chicken',
          variant: 'Half',
          foodType: 'non_veg',
          category: 'Mains',
          qty: 3,
          revenuePaise: 84000,
        },
      ],
      categories: [],
    });
    expect(table.rows[0]).toEqual(['Butter Chicken', 'Half', 'Mains', 'non_veg', 3, '840.00']);
  });

  it('writes activity rows with the restaurant clock', () => {
    expect(csvDateTime('2026-09-18T14:05:00+05:30', 'Asia/Kolkata')).toBe('2026-09-18 14:05');
    const table = activityCsv(
      parseActivityReport({
        today: '2026-09-18',
        from: '2026-09-18',
        to: '2026-09-18',
        kind: 'deleted_orders',
        page: 1,
        page_size: 50,
        total: 1,
        rows: [
          {
            at: '2026-09-18T14:05:00+05:30',
            round_number: 2,
            table_label: '7',
            items: [{ name: 'Paneer Tikka', variant: null, quantity: 3 }],
            quantity: 3,
            value_paise: 84000,
            actor_name: 'Priya',
            actor_role: 'manager',
            reason: 'Kitchen ran out',
          },
        ],
      }),
      'Asia/Kolkata',
    );
    expect(table.rows[0]).toEqual([
      '2026-09-18 14:05',
      '7',
      2,
      'Paneer Tikka × 3',
      3,
      '840.00',
      'Priya',
      'manager',
      'Kitchen ran out',
    ]);
  });
});
