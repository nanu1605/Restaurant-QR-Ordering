import { z } from 'zod';

import type { FeatureKey } from '@/features/plans/plan-features';
import { DEFAULT_LOCALE, DEFAULT_TIMEZONE } from '@/lib/config';

/**
 * Shapes of the platform_* functions (spec §13.4, docs/DECISIONS.md P7-7 to
 * P7-11), labels, and date formatting for the super-admin panel. The platform
 * works in India time; each restaurant's own screens use its timezone.
 */

const iso = z.string();
const isoOrNull = z.string().nullable();

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'halted',
  'cancelled',
  'expired',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Payment failed',
  halted: 'Halted',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export const ACCESS_STATE_LABELS: Record<string, string> = {
  full: 'Full access',
  read_only: 'Read-only',
};

export const ACCESS_REASON_LABELS: Record<string, string> = {
  suspended: 'Suspended',
  no_subscription: 'No subscription',
  trial_ended: 'Trial ended',
  subscription_lapsed: 'Subscription lapsed',
  payment_failed: 'Payment failed',
  subscription_ended: 'Subscription ended',
};

export const MANUAL_MODES = ['bank_transfer', 'upi', 'cash', 'cheque'] as const;
export type ManualMode = (typeof MANUAL_MODES)[number];
export const MANUAL_MODE_LABELS: Record<ManualMode, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cash: 'Cash',
  cheque: 'Cheque',
};

export const PAYMENT_SOURCE_LABELS: Record<string, string> = {
  manual: 'Manual',
  razorpay: 'Razorpay',
  payment_link: 'Payment link',
};

export const ACTOR_TYPES = ['staff', 'customer', 'system', 'platform_admin'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export const ACTOR_TYPE_LABELS: Record<ActorType, string> = {
  staff: 'Staff',
  customer: 'Customer',
  system: 'System',
  platform_admin: 'Platform admin',
};

const subscriptionStatus = z.enum(SUBSCRIPTION_STATUSES);
const restaurantStatus = z.enum(['active', 'suspended']);
const billingCycle = z.enum(['monthly', 'yearly']);

// ─── Overview ────────────────────────────────────────────────────────────────
const overviewSchema = z.object({
  restaurants: z.object({
    total: z.number(),
    trialing: z.number(),
    active: z.number(),
    past_due: z.number(),
    read_only: z.number(),
    suspended: z.number(),
  }),
  mrr_paise: z.number(),
  orders_24h: z.number(),
  trials_ending: z.array(
    z.object({
      restaurant_id: z.string(),
      name: z.string(),
      slug: z.string(),
      plan_name: z.string(),
      trial_ends_at: iso,
    }),
  ),
});
export type PlatformOverview = z.infer<typeof overviewSchema>;
export const parseOverview = (json: unknown) => overviewSchema.parse(json);

// ─── Restaurants list ────────────────────────────────────────────────────────
const restaurantRowSchema = z.object({
  restaurant_id: z.string(),
  name: z.string(),
  slug: z.string(),
  city: z.string().nullable(),
  status: restaurantStatus,
  created_at: iso,
  plan_code: z.string().nullable(),
  plan_name: z.string().nullable(),
  subscription_status: subscriptionStatus.nullable(),
  trial_ends_at: isoOrNull,
  current_period_end: isoOrNull,
  access_state: z.string(),
  last_order_at: isoOrNull,
});
const restaurantListSchema = z.object({
  page: z.number(),
  page_size: z.number(),
  total: z.number(),
  rows: z.array(restaurantRowSchema),
  cities: z.array(z.string()),
});
export type RestaurantList = z.infer<typeof restaurantListSchema>;
export type RestaurantRow = z.infer<typeof restaurantRowSchema>;
export const parseRestaurantList = (json: unknown) => restaurantListSchema.parse(json);

// ─── Subscriptions list ──────────────────────────────────────────────────────
const subscriptionRowSchema = z.object({
  restaurant_id: z.string(),
  name: z.string(),
  slug: z.string(),
  restaurant_status: restaurantStatus,
  plan_code: z.string(),
  plan_name: z.string(),
  billing_cycle: billingCycle.nullable(),
  status: subscriptionStatus,
  source: z.string().nullable(),
  trial_ends_at: isoOrNull,
  current_period_end: isoOrNull,
  grace_until: isoOrNull,
  cancel_at_period_end: z.boolean(),
  access_state: z.string(),
});
const subscriptionListSchema = z.object({
  page: z.number(),
  page_size: z.number(),
  total: z.number(),
  rows: z.array(subscriptionRowSchema),
});
export type SubscriptionList = z.infer<typeof subscriptionListSchema>;
export const parseSubscriptionList = (json: unknown) => subscriptionListSchema.parse(json);

// ─── Restaurant detail ───────────────────────────────────────────────────────
const restaurantDetailSchema = z.object({
  restaurant: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    legal_name: z.string().nullable(),
    address_line: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    pincode: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    gstin: z.string().nullable(),
    gst_mode: z.string(),
    timezone: z.string(),
    status: restaurantStatus,
    suspended_reason: z.string().nullable(),
    created_at: iso,
  }),
  owners: z.array(
    z.object({
      member_id: z.string(),
      display_name: z.string(),
      username: z.string(),
      is_active: z.boolean(),
      email: z.string().nullable(),
      email_is_real: z.boolean(),
      last_sign_in_at: isoOrNull,
    }),
  ),
  subscription: z
    .object({
      plan_id: z.string(),
      plan_code: z.string(),
      plan_name: z.string(),
      billing_cycle: billingCycle.nullable(),
      status: subscriptionStatus,
      source: z.string().nullable(),
      trial_ends_at: isoOrNull,
      current_period_start: isoOrNull,
      current_period_end: isoOrNull,
      grace_until: isoOrNull,
      cancel_at_period_end: z.boolean(),
      razorpay_subscription_id: z.string().nullable(),
    })
    .nullable(),
  payments: z.array(
    z.object({
      payment_id: z.string(),
      source: z.string(),
      amount_paise: z.number(),
      manual_mode: z.enum(MANUAL_MODES).nullable(),
      period_start: isoOrNull,
      period_end: isoOrNull,
      notes: z.string().nullable(),
      created_at: iso,
    }),
  ),
  access: z.object({
    state: z.string(),
    reason: z.string().nullable(),
    restriction_at: isoOrNull,
    warning: z.string().nullable(),
  }),
  usage: z.object({
    tables_active: z.number(),
    staff_logins: z.number(),
    waiters: z.number(),
    orders_7d: z.number(),
    orders_30d: z.number(),
    last_order_at: isoOrNull,
    bills: z.number(),
    bills_30d: z.number(),
  }),
});
export type RestaurantDetail = z.infer<typeof restaurantDetailSchema>;
export const parseRestaurantDetail = (json: unknown) => restaurantDetailSchema.parse(json);

// ─── Support view ────────────────────────────────────────────────────────────
export const SUPPORT_SECTIONS = ['menu', 'tables', 'board', 'total_orders'] as const;
export type SupportSection = (typeof SUPPORT_SECTIONS)[number];
export const SUPPORT_SECTION_LABELS: Record<SupportSection, string> = {
  menu: 'Menu',
  tables: 'Tables',
  board: 'Live board',
  total_orders: 'Total orders',
};

export const supportRestaurantSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  status: restaurantStatus,
});
export type SupportRestaurant = z.infer<typeof supportRestaurantSchema>;

const supportMenuSchema = z.object({
  categories: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      is_active: z.boolean(),
      items: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().nullable(),
          food_type: z.enum(['veg', 'non_veg', 'egg']),
          price_paise: z.number(),
          is_available: z.boolean(),
          is_active: z.boolean(),
          variants: z.array(z.object({ name: z.string(), price_paise: z.number() })),
        }),
      ),
    }),
  ),
});
export type SupportMenu = z.infer<typeof supportMenuSchema>;
export const parseSupportMenu = (json: unknown) => supportMenuSchema.parse(json);

const supportTablesSchema = z.object({
  tables: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      is_active: z.boolean(),
      opened_at: isoOrNull,
    }),
  ),
});
export type SupportTables = z.infer<typeof supportTablesSchema>;
export const parseSupportTables = (json: unknown) => supportTablesSchema.parse(json);

// ─── Audit log ───────────────────────────────────────────────────────────────
const auditRowSchema = z.object({
  id: z.string(),
  created_at: iso,
  restaurant_id: z.string().nullable(),
  restaurant_name: z.string().nullable(),
  restaurant_slug: z.string().nullable(),
  actor_type: z.enum(ACTOR_TYPES),
  actor_label: z.string(),
  actor_role: z.string().nullable(),
  actor_email: z.string().nullable(),
  action: z.string(),
  entity_type: z.string().nullable(),
  entity_id: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  reason: z.string().nullable(),
});
const auditListSchema = z.object({
  page: z.number(),
  page_size: z.number(),
  total: z.number(),
  rows: z.array(auditRowSchema),
});
export type AuditList = z.infer<typeof auditListSchema>;
export type AuditRow = z.infer<typeof auditRowSchema>;
export const parseAuditList = (json: unknown) => auditListSchema.parse(json);

// ─── Plans ───────────────────────────────────────────────────────────────────
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  kds: 'Kitchen view',
  discounts: 'Discounts',
  split_payments: 'Split payments',
  upi_qr_on_bill: 'UPI QR on bills',
  advanced_reports: 'Advanced reports',
  waiter_reports: 'Waiter report',
  csv_export: 'CSV export',
  remove_branding: 'No "Powered by" line',
};

export const planSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  price_monthly_paise: z.number(),
  price_yearly_paise: z.number(),
  razorpay_plan_id_monthly: z.string().nullable(),
  razorpay_plan_id_yearly: z.string().nullable(),
  max_tables: z.number().nullable(),
  max_staff: z.number().nullable(),
  features: z.record(z.string(), z.boolean()),
  is_active: z.boolean(),
  sort_order: z.number(),
});
export type Plan = z.infer<typeof planSchema>;

// ─── Dates (India time) ──────────────────────────────────────────────────────
const dateTimeFormat = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
  timeZone: DEFAULT_TIMEZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const dateFormat = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
  timeZone: DEFAULT_TIMEZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function formatDateTime(value: string | null): string {
  return value ? dateTimeFormat.format(new Date(value)) : '—';
}

/** Today's date in India, 'YYYY-MM-DD'. */
export function todayInIndia(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIMEZONE }).format(now);
}

export function formatDate(value: string | null): string {
  return value ? dateFormat.format(new Date(value)) : '—';
}

/** A period whose end is the start of the next business day, shown with its last day. */
export function formatPeriod(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const lastDay = new Date(new Date(end).getTime() - 24 * 60 * 60 * 1000).toISOString();
  return `${formatDate(start)} – ${formatDate(lastDay)}`;
}

/**
 * The authenticator QR code as an image src. GoTrue returns the SVG as raw
 * text behind a data: prefix, with a trailing newline, which next/image
 * rejects and a `#` in the markup would cut short, so it is percent-encoded.
 */
export function qrCodeDataUrl(qrCode: string): string {
  const raw = qrCode.trim();
  if (raw.startsWith('data:') && raw.slice(0, raw.indexOf(',')).endsWith(';base64')) return raw;
  const svg = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.trim())}`;
}
