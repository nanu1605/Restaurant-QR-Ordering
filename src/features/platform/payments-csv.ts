import { csvDateTime, paiseToRupees, type CsvTable } from '@/features/reports/csv';
import { DEFAULT_TIMEZONE } from '@/lib/config';

import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_PURPOSE_LABELS,
  paymentRecordedBy,
  periodLastDay,
  todayInIndia,
  type PaymentRow,
} from './platform';

/**
 * The payments ledger as a CSV (docs/DECISIONS.md SA-18): the screen's rows
 * and columns, amounts in rupees, dates in India time.
 */
export function paymentsCsv(rows: PaymentRow[]): CsvTable {
  return {
    headers: [
      'Date',
      'Restaurant',
      'Code',
      'For',
      'Plan',
      'Cycle',
      'Amount',
      'GST',
      'Total',
      'Method',
      'Razorpay payment ID',
      'Period first day',
      'Period last day',
      'Recorded by',
      'Notes',
    ],
    rows: rows.map((row) => [
      csvDateTime(row.created_at, DEFAULT_TIMEZONE),
      row.restaurant_name,
      row.slug,
      PAYMENT_PURPOSE_LABELS[row.purpose],
      row.plan_name,
      row.billing_cycle === 'yearly'
        ? 'Yearly'
        : row.billing_cycle === 'monthly'
          ? 'Monthly'
          : null,
      paiseToRupees(row.base_paise),
      paiseToRupees(row.gst_paise),
      paiseToRupees(row.amount_paise),
      PAYMENT_METHOD_LABELS[row.method],
      row.razorpay_payment_id,
      row.period_start ? todayInIndia(new Date(row.period_start)) : null,
      row.period_end ? todayInIndia(new Date(periodLastDay(row.period_end))) : null,
      paymentRecordedBy(row),
      row.notes,
    ]),
  };
}
