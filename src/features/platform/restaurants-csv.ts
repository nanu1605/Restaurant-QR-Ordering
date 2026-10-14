import { csvDateTime, paiseToRupees, type CsvTable } from '@/features/reports/csv';
import { DEFAULT_TIMEZONE } from '@/lib/config';

import {
  ACQUISITION_CHANNEL_LABELS,
  HEALTH_LABELS,
  periodLastDay,
  SUBSCRIPTION_STATE_LABELS,
  todayInIndia,
  type RestaurantRow,
} from './platform';

/** The day a restaurant is paid or on trial till ('YYYY-MM-DD', India). */
export function paidTillDay(row: Pick<RestaurantRow, 'paid_till' | 'subscription_status'>) {
  if (!row.paid_till) return null;
  return todayInIndia(
    new Date(row.subscription_status === 'trialing' ? row.paid_till : periodLastDay(row.paid_till)),
  );
}

/**
 * The filtered restaurants as a CSV (docs/DECISIONS.md SA-23): every column,
 * whichever are shown, amounts in rupees, money before GST with the GST apart.
 */
export function restaurantsCsv(rows: RestaurantRow[]): CsvTable {
  return {
    headers: [
      'Restaurant',
      'Code',
      'City',
      'Indian state',
      'Phone',
      'State',
      'Plan',
      'Cycle',
      'Paid or trial till',
      'Paid for subscriptions',
      'Paid for setup',
      'GST paid',
      'GMV, last 30 days',
      'Orders, last 7 days',
      'Health',
      'Last active',
      'Found us',
      'Created',
    ],
    rows: rows.map((row) => [
      row.name,
      row.slug,
      row.city,
      row.region,
      row.phone,
      SUBSCRIPTION_STATE_LABELS[row.state],
      row.plan_name,
      row.billing_cycle === 'yearly'
        ? 'Yearly'
        : row.billing_cycle === 'monthly'
          ? 'Monthly'
          : null,
      paidTillDay(row),
      paiseToRupees(row.paid.subscription_paise),
      paiseToRupees(row.paid.setup_fee_paise),
      paiseToRupees(row.paid.gst_paise),
      paiseToRupees(row.gmv_30d_paise),
      (row.orders_7d ?? []).reduce((sum, n) => sum + n, 0),
      HEALTH_LABELS[row.health],
      row.last_active ? csvDateTime(row.last_active, DEFAULT_TIMEZONE) : null,
      row.acquisition_channel ? ACQUISITION_CHANNEL_LABELS[row.acquisition_channel] : null,
      todayInIndia(new Date(row.created_at)),
    ]),
  };
}
