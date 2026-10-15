import { z } from 'zod';

import {
  addDays,
  daysBetween,
  firstParam,
  readDateRange,
  type SearchParams,
} from '@/lib/date-range';

/**
 * Usage analytics (docs/SUPER_ADMIN_PLAN.md 13e and §5.10, docs/DECISIONS.md
 * SA-61 to SA-64): GMV and orders over each restaurant's business days.
 */

// ─── Features in use ─────────────────────────────────────────────────────────
export const USAGE_FEATURES = [
  'kitchen_view',
  'waiter_assignment',
  'upi_qr_on_bill',
  'hindi_staff',
  'hindi_menu',
  'addons',
  'service_requests',
  'discounts',
  'split_payments',
  'menu_photo_import',
] as const;
export type UsageFeature = (typeof USAGE_FEATURES)[number];

/** Each feature's name and the rule that counts it as used (SA-63). */
export const USAGE_FEATURE_RULES: Record<UsageFeature, { label: string; rule: string }> = {
  kitchen_view: {
    label: 'Kitchen view',
    rule: 'The plan has it and a kitchen login is active, now',
  },
  waiter_assignment: { label: 'Waiter assignment', rule: 'A bill for a table a waiter had' },
  upi_qr_on_bill: {
    label: 'UPI QR on bills',
    rule: 'Turned on with a UPI ID and in the plan, now',
  },
  hindi_staff: { label: 'Worker panel in Hindi', rule: 'An active login uses Hindi, now' },
  hindi_menu: {
    label: 'Customer menu in Hindi',
    rule: 'An order placed from the Hindi menu (orders record it since usage analytics began)',
  },
  addons: { label: 'Add-ons', rule: 'An accepted order with an add-on' },
  service_requests: {
    label: 'Call waiter and request bill',
    rule: 'A guest called a waiter or asked for the bill',
  },
  discounts: { label: 'Discounts', rule: 'A bill with a discount' },
  split_payments: { label: 'Split payments', rule: 'A bill paid in more than one payment' },
  menu_photo_import: {
    label: 'Menu photo import',
    rule: 'A menu imported from photos by the restaurant, not the team',
  },
};

export const featuresUsedSchema = z.object(
  Object.fromEntries(USAGE_FEATURES.map((key) => [key, z.boolean()])) as Record<
    UsageFeature,
    z.ZodBoolean
  >,
);

// ─── The report ──────────────────────────────────────────────────────────────
const group = z.object({
  name: z.string().nullable(),
  restaurants: z.number(),
  active: z.number(),
  orders: z.number(),
  gmv_paise: z.number(),
});
const ranked = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    city: z.string().nullable(),
    orders: z.number(),
    gmv_paise: z.number(),
  }),
);
const counts = z.object({
  active: z.number(),
  orders: z.number(),
  customer_orders: z.number(),
  staff_orders: z.number(),
  items: z.number(),
  bills: z.number(),
  gmv_paise: z.number(),
});

const usageReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  previous_from: z.string().nullable(),
  previous_to: z.string().nullable(),
  totals: counts.extend({
    restaurants: z.number(),
    discount_paise: z.number(),
    collected: z.object({
      cash: z.number(),
      upi: z.number(),
      card: z.number(),
      other: z.number(),
    }),
    table_minutes: z.number().nullable(),
    service_requests: z.number(),
  }),
  previous: counts.nullable(),
  days: z.array(z.object({ day: z.string(), gmv_paise: z.number(), orders: z.number() })),
  by_city: z.array(group),
  by_state: z.array(group),
  by_plan: z.array(group.extend({ code: z.string().nullable() })),
  top_gmv: ranked,
  bottom_gmv: ranked,
  top_orders: ranked,
  bottom_orders: ranked,
  hours: z.array(z.object({ weekday: z.number(), hour: z.number(), orders: z.number() })),
  features: z.object({
    restaurants: z.number(),
    used: z.record(z.string(), z.number()),
  }),
});
export type UsageReport = z.infer<typeof usageReportSchema>;
export type UsageGroup = UsageReport['by_city'][number];
export const parseUsageReport = (json: unknown) => usageReportSchema.parse(json);

// ─── The page's URL ──────────────────────────────────────────────────────────
export const SERIES_BY = ['day', 'week', 'month'] as const;
export type SeriesBy = (typeof SERIES_BY)[number];
export const GROUP_RANKS = ['gmv', 'restaurants'] as const;
export type GroupRank = (typeof GROUP_RANKS)[number];

export type UsageParams = {
  from: string;
  to: string;
  compare: boolean;
  by: SeriesBy;
  rank: GroupRank;
  notice: string | null;
};

const oneOf = <T extends string>(value: string | undefined, values: readonly T[]) =>
  values.includes(value as T) ? (value as T) : undefined;

/** Day bars for a month, weeks up to about six months, months beyond. */
export function defaultSeriesBy(from: string, to: string): SeriesBy {
  const days = daysBetween(from, to) + 1;
  return days <= 31 ? 'day' : days <= 183 ? 'week' : 'month';
}

/** The page's dates (the last 30 days unless chosen), compare, grouping and ranking. */
export function readUsageParams(params: SearchParams, today: string): UsageParams {
  const read = readDateRange(params, 'Usage');
  const { range } = read;
  const notice =
    read.notice && !range.from
      ? 'That date doesn’t exist, so the last 30 days are shown.'
      : read.notice;
  const from = range.from ?? addDays(today, -29);
  const to = range.to ?? (range.from ? range.from : today);
  return {
    from,
    to,
    compare: firstParam(params, 'compare') === '1',
    by: oneOf(firstParam(params, 'by'), SERIES_BY) ?? defaultSeriesBy(from, to),
    rank: oneOf(firstParam(params, 'rank'), GROUP_RANKS) ?? 'gmv',
    notice,
  };
}

/**
 * The business date most restaurants are in now: India's date until the
 * default 4 am day start (docs/DECISIONS.md SA-62), so "Today" matches Home.
 */
export function businessTodayInIndia(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(now.getTime() - 4 * 60 * 60 * 1000),
  );
}

// ─── Shaping ─────────────────────────────────────────────────────────────────
export type SeriesPoint = { start: string; gmvPaise: number; orders: number };

/**
 * Every day from `from` to `to` (missing days as zero), summed by day, ISO
 * week (from Monday) or calendar month; the first bucket starts at `from`.
 */
export function groupSeries(
  days: UsageReport['days'],
  from: string,
  to: string,
  by: SeriesBy,
): SeriesPoint[] {
  const byDay = new Map(days.map((day) => [day.day, day]));
  const points: SeriesPoint[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday 0
    const bucket =
      by === 'day' ? day : by === 'week' ? addDays(day, -weekday) : `${day.slice(0, 8)}01`;
    const start = bucket < from ? from : bucket;
    const last = points.at(-1);
    const point = last?.start === start ? last : { start, gmvPaise: 0, orders: 0 };
    if (point !== last) points.push(point);
    point.gmvPaise += byDay.get(day)?.gmv_paise ?? 0;
    point.orders += byDay.get(day)?.orders ?? 0;
  }
  return points;
}

/** "the previous 30 days", for a range of this many days. */
export function previousPeriodLabel(days: number): string {
  return days === 1 ? 'the day before' : `the previous ${days} days`;
}

/**
 * A figure against the period before (docs/SUPER_ADMIN_PLAN.md §1: honest
 * with small numbers, never extrapolated): a percentage, or what it was
 * when that was under 5.
 */
export function changeNote(
  now: number,
  before: number,
  period: string,
): { direction: 'up' | 'down' | null; text: string } {
  if (before < 5) {
    return {
      direction: null,
      text: `${before === 0 ? 'None' : before.toLocaleString('en-IN')} in ${period}`,
    };
  }
  const change = Math.round(((now - before) / before) * 100);
  if (change === 0) return { direction: null, text: `Same as ${period}` };
  return {
    direction: change > 0 ? 'up' : 'down',
    text: `${change > 0 ? 'Up' : 'Down'} ${Math.abs(change).toLocaleString('en-IN')}% on ${period}`,
  };
}

/** Groups ranked by GMV (the database's order) or by restaurants. */
export function rankGroups<T extends UsageGroup>(groups: T[], rank: GroupRank): T[] {
  if (rank === 'gmv') return groups;
  return [...groups].sort((a, b) => b.restaurants - a.restaurants || b.gmv_paise - a.gmv_paise);
}
