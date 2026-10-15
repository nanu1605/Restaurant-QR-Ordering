import { z } from 'zod';

import { SERIES_BY, defaultSeriesBy, type SeriesBy } from '@/features/usage/usage';
import { addDays, firstParam, isDate, readDateRange, type SearchParams } from '@/lib/date-range';

/**
 * Revenue analytics (docs/SUPER_ADMIN_PLAN.md 13f and §5.2 to §5.9,
 * docs/DECISIONS.md SA-65+): what restaurants pay MenuMesh, by India date.
 * MRR and every amount here exclude GST unless marked.
 */

// ─── MRR movement (plan §5.3) ────────────────────────────────────────────────
export const MOVEMENTS = ['new', 'reactivation', 'expansion', 'contraction', 'churn'] as const;
export type Movement = (typeof MOVEMENTS)[number];
export const MOVEMENT_LABELS: Record<Movement, string> = {
  new: 'New',
  reactivation: 'Reactivation',
  expansion: 'Expansion',
  contraction: 'Contraction',
  churn: 'Churn',
};

/** One value for each movement, in MOVEMENTS order. */
export const eachMovement = <T>(value: (kind: Movement) => T) =>
  Object.fromEntries(MOVEMENTS.map((kind) => [kind, value(kind)])) as Record<Movement, T>;

// ─── The report ──────────────────────────────────────────────────────────────
const change = z.object({ count: z.number(), paise: z.number() });
const movements = z.object({
  new: change,
  reactivation: change,
  expansion: change,
  contraction: change,
  churn: change,
});
const totals = z.object({
  mrr_paise: z.number().nullable(),
  paid: z.number().nullable(),
  opening_day: z.string().nullable(),
  opening_mrr_paise: z.number().nullable(),
  opening_paid: z.number().nullable(),
  movements,
  churned: z.number(),
  lost_paise: z.number(),
  collected: z.object({
    subscription_base_paise: z.number(),
    setup_fee_base_paise: z.number(),
    gst_paise: z.number(),
    count: z.number(),
  }),
  conversion: z.object({
    created: z.number(),
    converted: z.number(),
    deciding: z.number(),
    average_days: z.number().nullable(),
  }),
  recovery: z.object({
    entered: z.number(),
    recovered: z.number(),
    still_failed: z.number(),
  }),
});

const revenueReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  by: z.enum(SERIES_BY),
  previous_from: z.string().nullable(),
  previous_to: z.string().nullable(),
  history_starts_on: z.string().nullable(),
  totals,
  previous: totals.nullable(),
  series: z.array(
    z.object({
      start: z.string(),
      end: z.string(),
      mrr_paise: z.number().nullable(),
      paid: z.number().nullable(),
      movements,
      subscription_base_paise: z.number(),
      setup_fee_base_paise: z.number(),
      gst_paise: z.number(),
    }),
  ),
  plan_mix: z.array(
    z.object({
      plan_code: z.string(),
      plan_name: z.string(),
      billing_cycle: z.enum(['monthly', 'yearly']),
      restaurants: z.number(),
      mrr_paise: z.number(),
    }),
  ),
  cohorts: z.array(
    z.object({
      start: z.string(),
      created: z.number(),
      converted: z.number(),
      deciding: z.number(),
      average_days: z.number().nullable(),
    }),
  ),
  reasons: z.array(z.object({ reason: z.string().nullable(), count: z.number() })),
  launch_offer: z.object({
    setup_fees: z.number(),
    with_offer: z.number(),
    discount_paise: z.number(),
    full_price: z.number(),
    not_recorded: z.number(),
  }),
  // Offers and agreed prices (docs/DECISIONS.md SA-77+).
  discounts: z.object({
    payments: z.number(),
    restaurants: z.number(),
    discount_paise: z.number(),
    on_deal_now: z.number(),
    monthly_discount_now_paise: z.number(),
  }),
  expected: z.object({
    autopay_paise: z.number(),
    autopay_count: z.number(),
    needs_payment_paise: z.number(),
    needs_payment_count: z.number(),
  }),
});
export type RevenueReport = z.infer<typeof revenueReportSchema>;
export type RevenueTotals = RevenueReport['totals'];
export type RevenuePoint = RevenueReport['series'][number];
export const parseRevenueReport = (json: unknown) => revenueReportSchema.parse(json);

const movementListSchema = z.object({
  total: z.number(),
  rows: z.array(
    z.object({
      day: z.string(),
      restaurant_id: z.string(),
      name: z.string(),
      city: z.string().nullable(),
      state_before: z.string().nullable(),
      state_after: z.string(),
      plan_before: z.string().nullable(),
      plan_after: z.string().nullable(),
      before_paise: z.number(),
      after_paise: z.number(),
    }),
  ),
});
export type MovementList = z.infer<typeof movementListSchema>;
export const parseMovementList = (json: unknown) => movementListSchema.parse(json);

/** The change in MRR over the dates: the movements, which add up to it. */
export const netNewPaise = (moves: RevenueTotals['movements']) =>
  MOVEMENTS.reduce((sum, kind) => sum + moves[kind].paise, 0);

// ─── The page's URL ──────────────────────────────────────────────────────────
export type RevenueParams = {
  from: string;
  to: string;
  compare: boolean;
  by: SeriesBy;
  /** The movement whose restaurants are listed, and the bar's first day. */
  move: Movement | undefined;
  at: string | undefined;
  notice: string | null;
};

const oneOf = <T extends string>(value: string | undefined, values: readonly T[]) =>
  values.includes(value as T) ? (value as T) : undefined;

/**
 * The page's dates (the last 12 months unless chosen, never past today),
 * compare, grouping and list.
 */
export function readRevenueParams(params: SearchParams, today: string): RevenueParams {
  const read = readDateRange(params, 'Revenue');
  const { range } = read;
  let notice =
    read.notice && !range.from
      ? 'That date doesn’t exist, so the last 12 months are shown.'
      : read.notice;
  let from = range.from ?? addDays(today, -364);
  let to = range.to ?? (range.from ? range.from : today);
  if (to > today) {
    to = today;
    if (from > today) from = today;
    notice = 'Revenue shows up to today, so the dates end today.';
  }
  const at = firstParam(params, 'at');
  return {
    from,
    to,
    compare: firstParam(params, 'compare') === '1',
    by: oneOf(firstParam(params, 'by'), SERIES_BY) ?? defaultSeriesBy(from, to),
    move: oneOf(firstParam(params, 'move'), MOVEMENTS),
    at: isDate(at) && at >= from && at <= to ? at : undefined,
    notice,
  };
}

/**
 * The last day of the bar starting on `start`: the day, its Sunday or its
 * month's last day, never after `to` (as private.revenue_bucket groups them).
 */
export function bucketEnd(start: string, by: SeriesBy, to: string): string {
  const weekday = (new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday 0
  const end =
    by === 'day'
      ? start
      : by === 'week'
        ? addDays(start, 6 - weekday)
        : addDays(`${addDays(`${start.slice(0, 8)}01`, 31).slice(0, 8)}01`, -1);
  return end < to ? end : to;
}
