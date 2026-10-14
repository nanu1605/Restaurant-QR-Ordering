import { z } from 'zod';

import { FEATURE_LABELS, type FeatureKey } from '@/features/plans/plan-features';
import { CANCEL_REASON_LABELS, type CancelReason } from '@/features/subscriptions/cancel-reasons';
import { formatINR } from '@/lib/money';

import { DUES_BUCKETS, RENEWAL_KINDS, SUBSCRIPTION_STATUS_LABELS } from './platform';

/**
 * A restaurant's page (docs/SUPER_ADMIN_PLAN.md 13a, docs/DECISIONS.md SA-33
 * to SA-39): its tabs, and the shapes of what each tab reads.
 */

const iso = z.string();
const isoOrNull = z.string().nullable();

// The tabs, in order. `segment` is the folder under the restaurant's page
// (null for Overview), as useSelectedLayoutSegment reports it.
export const RESTAURANT_TABS = [
  { segment: null, path: '', label: 'Overview' },
  { segment: 'billing', path: '/billing', label: 'Billing' },
  { segment: 'usage', path: '/usage', label: 'Usage' },
  { segment: 'activity', path: '/activity', label: 'Activity' },
  { segment: 'notes', path: '/notes', label: 'Notes' },
  { segment: 'documents', path: '/documents', label: 'Documents' },
  { segment: 'support', path: '/support/menu', label: 'Support view' },
  { segment: 'menu-import', path: '/menu-import', label: 'Menu imports' },
] as const;

export const restaurantPath = (restaurantId: string, tab = '') =>
  `/super/restaurants/${restaurantId}${tab}`;

// ─── Overview ────────────────────────────────────────────────────────────────
const overviewSchema = z.object({
  last_day: z.string(),
  days: z.array(z.object({ day: z.string(), orders: z.number(), gmv_paise: z.number() })),
  last_30: z.object({
    orders: z.number(),
    customer_orders: z.number(),
    staff_orders: z.number(),
    bills: z.number(),
    gmv_paise: z.number(),
  }),
});
export type RestaurantOverview = z.infer<typeof overviewSchema>;
export const parseOverview = (json: unknown) => overviewSchema.parse(json);

/**
 * QR orders as a share of all orders (plan §5.10), honest with small numbers
 * (plan §1): "71% (430 of 612)", or just "2 of 3" below 5 orders.
 */
export function qrShare(customer: number, staff: number): string | null {
  const total = customer + staff;
  if (total === 0) return null;
  const fraction = `${customer.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')}`;
  return total < 5 ? fraction : `${Math.round((customer / total) * 100)}% (${fraction})`;
}

// ─── Billing ─────────────────────────────────────────────────────────────────
const billingSchema = z.object({
  dues: z
    .object({
      bucket: z.enum(DUES_BUCKETS),
      renewal_kind: z.enum(RENEWAL_KINDS).nullable(),
      // Null without money.view.
      due_paise: z.number().nullable(),
      grace_until: isoOrNull,
      trial_ends_at: isoOrNull,
      current_period_end: isoOrNull,
      restriction_at: isoOrNull,
    })
    .nullable(),
  reminders: z.array(z.object({ kind: z.string(), sent_at: iso })),
  links: z.array(
    z.object({
      at: iso,
      actor: z.string().nullable(),
      purpose: z.string().nullable(),
      months: z.number().nullable(),
      amount_paise: z.number().nullable(),
      short_url: z.string().nullable(),
      paid_at: isoOrNull,
    }),
  ),
  history: z.array(
    z.object({
      at: iso,
      action: z.string(),
      actor: z.string().nullable(),
      before: z.record(z.string(), z.unknown()).nullable(),
      after: z.record(z.string(), z.unknown()).nullable(),
      reason: z.string().nullable(),
    }),
  ),
});
export type RestaurantBilling = z.infer<typeof billingSchema>;
export type HistoryEntry = RestaurantBilling['history'][number];
export const parseBilling = (json: unknown) => billingSchema.parse(json);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** One line of the subscription's history, in words. `plans` names plan codes. */
export function historyLine(
  entry: HistoryEntry,
  plans: Record<string, string>,
  formatDate: (value: string) => string,
): string {
  const before = entry.before ?? {};
  const after = entry.after ?? {};
  const plan = (code: unknown) => (text(code) ? (plans[code as string] ?? (code as string)) : '—');
  switch (entry.action) {
    case 'subscription.plan_changed':
      return `Plan changed from ${plan(before.plan_code)} to ${plan(after.plan_code)}`;
    case 'subscription.trial_extended': {
      const end = text(after.trial_ends_at);
      return `Trial extended by ${after.days ?? '?'} days${end ? `, to ${formatDate(end)}` : ''}`;
    }
    case 'subscription.autopay_started':
      return `Autopay set up for ${plan(after.plan_code)}${
        text(after.billing_cycle) ? `, ${after.billing_cycle}` : ''
      }`;
    case 'subscription.cancel_scheduled':
      return 'Autopay turned off: the plan ends with the paid period';
    case 'subscription.cancel_reason': {
      const reason = text(after.reason) as CancelReason | null;
      const label = reason ? (CANCEL_REASON_LABELS[reason] ?? reason) : 'No reason';
      return `Reason for leaving: ${label}${text(after.detail) ? ` (${after.detail})` : ''}`;
    }
    case 'subscription.razorpay_updated': {
      const status = (value: unknown) =>
        text(value)
          ? (SUBSCRIPTION_STATUS_LABELS[value as keyof typeof SUBSCRIPTION_STATUS_LABELS] ??
            (value as string))
          : '—';
      return before.status === after.status
        ? 'Razorpay updated the subscription'
        : `Razorpay: ${status(before.status)} to ${status(after.status)}`;
    }
    case 'restaurant.suspended':
      return 'Suspended';
    case 'restaurant.unsuspended':
      return 'Unsuspended';
    default:
      return entry.action;
  }
}

/** "₹1,060.82 for 1 month", "Setup fee, ₹588.82": what a payment link asked for. */
export function linkLabel(link: RestaurantBilling['links'][number]): string {
  const what =
    link.purpose === 'setup_fee'
      ? 'Setup fee'
      : link.months
        ? `${link.months} ${link.months === 1 ? 'month' : 'months'}`
        : 'Subscription';
  return link.amount_paise === null ? what : `${what}, ${formatINR(link.amount_paise)}`;
}

// ─── Usage ───────────────────────────────────────────────────────────────────
const usageSchema = z.object({
  from: z.string(),
  to: z.string(),
  start_hour: z.number(),
  hours: z.array(z.object({ weekday: z.number(), hour: z.number(), orders: z.number() })),
  limit_hits: z.array(
    z.object({
      kind: z.enum(['tables', 'staff', 'feature']),
      feature: z.string().nullable(),
      count: z.number(),
      last_at: iso,
    }),
  ),
});
export type RestaurantUsage = z.infer<typeof usageSchema>;
export const parseUsage = (json: unknown) => usageSchema.parse(json);

/** What a plan-limit hit was about. */
export function limitHitLabel(hit: RestaurantUsage['limit_hits'][number]): string {
  if (hit.kind === 'tables') return 'More tables than the plan allows';
  if (hit.kind === 'staff') return 'More staff logins than the plan allows';
  const feature = hit.feature ?? '';
  return `${FEATURE_LABELS[feature as FeatureKey] ?? feature}, not in the plan`;
}

// ─── Notes ───────────────────────────────────────────────────────────────────
export const NOTE_EDIT_MINUTES = 15;
const notesSchema = z.array(
  z.object({
    id: z.string(),
    body: z.string(),
    pinned: z.boolean(),
    author: z.string().nullable(),
    created_at: iso,
    edited_at: isoOrNull,
    // Set while this admin may still edit it (their own note, first 15 minutes).
    editable_until: isoOrNull,
  }),
);
export type RestaurantNote = z.infer<typeof notesSchema>[number];
export const parseNotes = (json: unknown) => notesSchema.parse(json);

export const noteSchema = z.object({
  body: z.string().trim().min(1, 'Write the note.').max(2000, 'Use 2,000 characters or fewer.'),
});
export type NoteInput = z.input<typeof noteSchema>;

// ─── Team ────────────────────────────────────────────────────────────────────
const teamSchema = z.array(z.object({ user_id: z.string(), email: z.string() }));
export type TeamMember = z.infer<typeof teamSchema>[number];
export const parseTeam = (json: unknown) => teamSchema.parse(json);

export const tagNameSchema = z.object({
  name: z.string().trim().min(1, 'Name the tag.').max(30, 'Use 30 characters or fewer.'),
});
