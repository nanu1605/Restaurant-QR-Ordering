import { DEFAULT_LOCALE } from '@/lib/config';

import {
  type ActivityReport,
  dishLabel,
  hourLabel,
  type ItemsReport,
  type SalesReport,
  type TablesReport,
  WEEKDAYS,
  type WaiterReport,
} from './report';

/**
 * CSV downloads of the reports (spec §19 Phase 6, plan feature csv_export).
 * Money is written in rupees so spreadsheets add it up; text that could be
 * read as a formula is prefixed (docs/DECISIONS.md P6-13).
 */

export type CsvCell = string | number | null | undefined;

export type CsvTable = { headers: string[]; rows: CsvCell[][] };

const NEEDS_QUOTES = /[",\r\n]/;
const LOOKS_LIKE_FORMULA = /^[=+\-@\t\r]/;
/** A plain amount such as "-0.50": a spreadsheet must read it as a number. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** Rupees with two decimals, without a currency sign: 66250 → "662.50". */
export function paiseToRupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  const text = LOOKS_LIKE_FORMULA.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A CSV file: a byte-order mark so Excel reads ₹ and Hindi, and CRLF rows. */
export function toCsv({ headers, rows }: CsvTable): string {
  const lines = [headers, ...rows].map((row) => row.map(cell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** "sales-2026-09-01-to-2026-09-17.csv" */
export function csvFilename(report: string, from: string, to: string): string {
  return from === to ? `${report}-${from}.csv` : `${report}-${from}-to-${to}.csv`;
}

/** "2026-09-17 20:45" in the restaurant's timezone, for spreadsheet sorting. */
export function csvDateTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

// ─── One table per report ─────────────────────────────────────────────────────

export function salesCsv(report: SalesReport): CsvTable {
  return {
    headers: [
      'Date',
      'Bills',
      'Gross',
      'Discounts',
      'Service charge',
      'GST',
      'Round off',
      'Net sales',
      'Total billed',
      'Average bill',
      'Cash',
      'UPI',
      'Card',
      'Other',
      'Unpaid bills',
    ],
    rows: (report.days ?? []).map((d) => [
      d.date,
      d.bills,
      paiseToRupees(d.grossPaise),
      paiseToRupees(d.discountPaise),
      paiseToRupees(d.serviceChargePaise),
      paiseToRupees(d.taxPaise),
      paiseToRupees(d.roundOffPaise),
      paiseToRupees(d.netPaise),
      paiseToRupees(d.totalPaise),
      paiseToRupees(d.averagePaise),
      paiseToRupees(d.collected?.cash ?? 0),
      paiseToRupees(d.collected?.upi ?? 0),
      paiseToRupees(d.collected?.card ?? 0),
      paiseToRupees(d.collected?.other ?? 0),
      d.unpaidBills,
    ]),
  };
}

export function hoursCsv(report: SalesReport): CsvTable {
  return {
    headers: ['Day', 'Hour', 'Bills', 'Total billed'],
    rows: (report.hours ?? []).map((h) => [
      WEEKDAYS[h.weekday - 1] ?? String(h.weekday),
      hourLabel(h.hour),
      h.bills,
      paiseToRupees(h.totalPaise),
    ]),
  };
}

export function itemsCsv(report: ItemsReport): CsvTable {
  return {
    headers: ['Dish', 'Variant', 'Category', 'Food type', 'Quantity', 'Sales'],
    rows: report.items.map((i) => [
      i.name,
      i.variant,
      i.category,
      i.foodType,
      i.qty,
      paiseToRupees(i.revenuePaise),
    ]),
  };
}

export function categoriesCsv(report: ItemsReport): CsvTable {
  return {
    headers: ['Category', 'Dishes', 'Quantity', 'Sales'],
    rows: report.categories.map((c) => [c.name, c.dishes, c.qty, paiseToRupees(c.revenuePaise)]),
  };
}

export function tablesCsv(report: TablesReport): CsvTable {
  return {
    headers: ['Table', 'Sessions', 'Average minutes', 'Sales', 'Average bill', 'In use'],
    rows: report.tables.map((t) => [
      t.label,
      t.sessions,
      t.minutes,
      paiseToRupees(t.totalPaise),
      paiseToRupees(t.averagePaise),
      t.isActive ? 'Yes' : 'No',
    ]),
  };
}

export function waitersCsv(report: WaiterReport): CsvTable {
  return {
    headers: [
      'Waiter',
      'Tables',
      'Sales',
      'Average table time (minutes)',
      'Rounds',
      'Dishes',
      'Open tables now',
      'Working here',
    ],
    rows: report.waiters.map((w) => [
      w.name,
      w.tables,
      paiseToRupees(w.salesPaise),
      w.minutes,
      w.rounds,
      w.items,
      w.openTables,
      w.isActive ? 'Yes' : 'No',
    ]),
  };
}

export function activityCsv(report: ActivityReport, timeZone: string): CsvTable {
  if (report.kind === 'voids_discounts') {
    return {
      headers: [
        'When',
        'What',
        'Invoice',
        'Table',
        'Amount',
        'Bill total',
        'Bill status',
        'By',
        'Role',
        'Reason',
      ],
      rows: report.rows.map((r) => [
        csvDateTime(r.at, timeZone),
        r.kind === 'void' ? 'Void' : 'Discount',
        r.invoiceNumber,
        r.tableLabel,
        paiseToRupees(r.amountPaise),
        paiseToRupees(r.totalPaise),
        r.billStatus === 'void' ? 'Void' : 'Active',
        r.actorName,
        r.actorRole,
        r.reason,
      ]),
    };
  }
  if (report.kind === 'removed_items') {
    return {
      headers: [
        'When',
        'Dish',
        'Quantity',
        'Value',
        'Was served',
        'Table',
        'Round',
        'By',
        'Role',
        'Reason',
      ],
      rows: report.rows.map((r) => [
        csvDateTime(r.at, timeZone),
        dishLabel(r.name ?? '', r.variant),
        r.quantity,
        paiseToRupees(r.valuePaise),
        r.wasServed ? 'Yes' : 'No',
        r.tableLabel,
        r.roundNumber,
        r.actorName,
        r.actorRole,
        r.reason,
      ]),
    };
  }
  return {
    headers: ['When', 'Table', 'Round', 'Dishes', 'Quantity', 'Value', 'By', 'Role', 'Reason'],
    rows: report.rows.map((r) => [
      csvDateTime(r.at, timeZone),
      r.tableLabel,
      r.roundNumber,
      r.items.map((i) => `${dishLabel(i.name ?? '', i.variant)} × ${i.quantity}`).join('; '),
      r.quantity,
      paiseToRupees(r.valuePaise),
      r.actorName,
      r.actorRole,
      r.reason,
    ]),
  };
}
