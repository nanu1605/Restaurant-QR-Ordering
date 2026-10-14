import { z } from 'zod';

import { onboardingSummarySchema } from '@/features/onboarding/onboarding';
import { CANCEL_REASONS } from '@/features/subscriptions/cancel-reasons';
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

// One state per restaurant, first match wins (docs/SUPER_ADMIN_PLAN.md §5.1,
// private.subscription_state in SQL).
export const SUBSCRIPTION_STATES = [
  'suspended',
  'read_only',
  'trial',
  'payment_failed',
  'paid',
  'cancelled',
] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];
export const SUBSCRIPTION_STATE_LABELS: Record<SubscriptionState, string> = {
  suspended: 'Suspended',
  read_only: 'Read-only',
  trial: 'Trial',
  payment_failed: 'Payment failed',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

// A restaurant's health, first match wins (docs/SUPER_ADMIN_PLAN.md §5.11,
// private.restaurant_health in SQL).
export const HEALTHS = ['setting_up', 'never_started', 'inactive', 'slowing', 'active'] as const;
export type Health = (typeof HEALTHS)[number];
export const HEALTH_LABELS: Record<Health, string> = {
  setting_up: 'Setting up',
  never_started: 'Never started',
  inactive: 'Inactive',
  slowing: 'Slowing',
  active: 'Active',
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

// How a restaurant found MenuMesh (docs/DECISIONS.md SA-12). Signup sets the
// first two itself; the onboarding wizard asks.
export const ACQUISITION_CHANNELS = [
  'website',
  'website_lead',
  'field_visit',
  'referral',
  'phone',
  'whatsapp',
  'social',
  'other',
] as const;
export type AcquisitionChannel = (typeof ACQUISITION_CHANNELS)[number];
export const ACQUISITION_CHANNEL_LABELS: Record<AcquisitionChannel, string> = {
  website: 'Signed up on the website',
  website_lead: 'Demo request on the website',
  field_visit: 'Field visit',
  referral: 'Referral',
  phone: 'Phone call',
  whatsapp: 'WhatsApp',
  social: 'Social media',
  other: 'Other',
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

// How a payment arrived: Razorpay autopay, a payment link, or a manual mode.
export const PAYMENT_METHODS = ['autopay', 'payment_link', ...MANUAL_MODES] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  autopay: 'Autopay',
  payment_link: 'Payment link',
  ...MANUAL_MODE_LABELS,
};

export const PAYMENT_PURPOSES = ['subscription', 'setup_fee'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];
export const PAYMENT_PURPOSE_LABELS: Record<PaymentPurpose, string> = {
  subscription: 'Subscription',
  setup_fee: 'Setup fee',
};

// Dues buckets, in the order a restaurant is placed (docs/SUPER_ADMIN_PLAN.md §5.6).
export const DUES_BUCKETS = ['payment_failed', 'lapsed', 'trial_ending', 'renewal_due'] as const;
export type DuesBucket = (typeof DUES_BUCKETS)[number];
export const DUES_BUCKET_LABELS: Record<DuesBucket, string> = {
  payment_failed: 'Payment failed',
  lapsed: 'Lapsed',
  trial_ending: 'Trial ending',
  renewal_due: 'Renewal due',
};

export const RENEWAL_KINDS = ['autopay', 'needs_payment', 'ending'] as const;
export type RenewalKind = (typeof RENEWAL_KINDS)[number];
export const RENEWAL_KIND_LABELS: Record<RenewalKind, string> = {
  autopay: 'On autopay',
  needs_payment: 'Needs a payment',
  ending: 'Ending',
};

// subscription_reminders.kind: the emails the daily cron sends (spec §14.6).
export const REMINDER_LABELS: Record<string, string> = {
  trial_ends_3d: 'Trial ends in 3 days',
  trial_ends_1d: 'Trial ends tomorrow',
  payment_failed: 'Payment failed',
  access_restricted: 'Ordering paused',
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
const subscriptionState = z.enum(SUBSCRIPTION_STATES);
const restaurantStatus = z.enum(['active', 'suspended']);
const billingCycle = z.enum(['monthly', 'yearly']);

// ─── Lookalikes (docs/DECISIONS.md P11-13) ───────────────────────────────────
export const LOOKALIKE_REASON_LABELS = {
  fssai: 'Same FSSAI licence',
  gstin: 'Same GSTIN',
  phone: 'Same mobile',
  name: 'Similar name',
  address: 'Similar address',
  pincode: 'Same pincode',
} as const;
const lookalikeReason = z.enum(
  Object.keys(LOOKALIKE_REASON_LABELS) as [keyof typeof LOOKALIKE_REASON_LABELS],
);
export const lookalikeSchema = z.object({
  restaurant_id: z.string(),
  name: z.string(),
  slug: z.string(),
  city: z.string().nullable(),
  reasons: z.array(lookalikeReason),
});
const lookalikesSchema = z.record(z.string(), z.array(lookalikeSchema));
export type Lookalike = z.infer<typeof lookalikeSchema>;
export const parseLookalikes = (json: unknown) => lookalikesSchema.parse(json);

// ─── Tags (docs/DECISIONS.md SA-39) ──────────────────────────────────────────
// Each colour is a swatch beside ink text, so every one reads in both themes.
export const TAG_COLOURS = ['orange', 'teal', 'amber', 'green', 'red', 'slate'] as const;
export type TagColour = (typeof TAG_COLOURS)[number];
export const TAG_COLOUR_LABELS: Record<TagColour, string> = {
  orange: 'Orange',
  teal: 'Teal',
  amber: 'Amber',
  green: 'Green',
  red: 'Red',
  slate: 'Grey',
};
export const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  colour: z.enum(TAG_COLOURS),
});
export type Tag = z.infer<typeof tagSchema>;

// ─── Restaurants list ────────────────────────────────────────────────────────
const restaurantRowSchema = z.object({
  restaurant_id: z.string(),
  name: z.string(),
  slug: z.string(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  phone: z.string().nullable(),
  status: restaurantStatus,
  created_at: iso,
  acquisition_channel: z.enum(ACQUISITION_CHANNELS).nullable(),
  plan_code: z.string().nullable(),
  plan_name: z.string().nullable(),
  billing_cycle: billingCycle.nullable(),
  subscription_status: subscriptionStatus.nullable(),
  state: subscriptionState,
  access_state: z.string(),
  // The trial's end while trialing, otherwise the paid period's (plan §5.5).
  paid_till: isoOrNull,
  // A paid period set to end there.
  ending: z.boolean(),
  health: z.enum(HEALTHS),
  last_active: isoOrNull,
  gmv_30d_paise: z.number(),
  // Accepted orders on each of the last 7 finished business days, oldest first.
  orders_7d: z.array(z.number()).nullable(),
  // Null without money.view.
  paid: z
    .object({
      subscription_paise: z.number(),
      setup_fee_paise: z.number(),
      gst_paise: z.number(),
    })
    .nullable(),
  tags: z.array(tagSchema),
  // The account manager's email.
  account_manager: z.string().nullable(),
  onboarding: onboardingSummarySchema,
});
const restaurantListSchema = z.object({
  page: z.number(),
  page_size: z.number(),
  total: z.number(),
  rows: z.array(restaurantRowSchema),
  cities: z.array(z.string()),
  regions: z.array(z.string()),
});
export type RestaurantList = z.infer<typeof restaurantListSchema>;
export type RestaurantRow = z.infer<typeof restaurantRowSchema>;
export const parseRestaurantList = (json: unknown) => restaurantListSchema.parse(json);

// The restaurants list's optional columns (docs/DECISIONS.md SA-23), in order.
export const RESTAURANT_COLUMNS = [
  'state',
  'plan',
  'paid_till',
  'lifetime',
  'gmv',
  'orders',
  'health',
  'onboarding',
  'last_active',
  'phone',
  'tags',
  'manager',
  'channel',
  'created',
] as const;
export type RestaurantColumn = (typeof RESTAURANT_COLUMNS)[number];
export const RESTAURANT_COLUMN_LABELS: Record<RestaurantColumn, string> = {
  state: 'State',
  plan: 'Plan',
  paid_till: 'Paid till',
  lifetime: 'Lifetime paid',
  gmv: 'GMV, 30 days',
  orders: 'Orders, 7 days',
  health: 'Health',
  onboarding: 'Onboarding',
  last_active: 'Last active',
  phone: 'Phone',
  tags: 'Tags',
  manager: 'Account manager',
  channel: 'Found us',
  created: 'Created',
};
export const DEFAULT_RESTAURANT_COLUMNS: RestaurantColumn[] = RESTAURANT_COLUMNS.filter(
  (column) => column !== 'channel' && column !== 'manager' && column !== 'onboarding',
);

/** The columns of the Onboarding view: the default ones and where onboarding stands. */
export const ONBOARDING_VIEW_COLUMNS = RESTAURANT_COLUMNS.filter(
  (column) => DEFAULT_RESTAURANT_COLUMNS.includes(column) || column === 'onboarding',
).join(',');

/** The list's onboarding filter (docs/DECISIONS.md SA-41): a step still to do, stuck, or done. */
export const ONBOARDING_FILTERS = ['open', 'stuck', 'done'] as const;
export type OnboardingFilter = (typeof ONBOARDING_FILTERS)[number];
export const ONBOARDING_FILTER_LABELS: Record<OnboardingFilter, string> = {
  open: 'Not finished',
  stuck: 'Stuck',
  done: 'Done',
};

// ─── Search (docs/DECISIONS.md SA-25) ────────────────────────────────────────
const searchResultsSchema = z.object({
  restaurants: z.array(
    z.object({
      restaurant_id: z.string(),
      name: z.string(),
      slug: z.string(),
      city: z.string().nullable(),
      match: z.string().nullable(),
    }),
  ),
  payments: z.array(
    z.object({
      restaurant_id: z.string(),
      name: z.string(),
      kind: z.enum(['payment', 'subscription']),
      ref: z.string(),
    }),
  ),
  leads: z.array(
    z.object({
      lead_id: z.string(),
      name: z.string(),
      restaurant_name: z.string().nullable(),
      phone: z.string().nullable(),
      created_at: iso,
    }),
  ),
});
export type SearchResults = z.infer<typeof searchResultsSchema>;
export const parseSearchResults = (json: unknown) => searchResultsSchema.parse(json);

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
  state: subscriptionState,
  // A paid period set to end: cancelled, or autopay switched off.
  ending: z.boolean(),
});
const subscriptionListSchema = z.object({
  page: z.number(),
  page_size: z.number(),
  total: z.number(),
  rows: z.array(subscriptionRowSchema),
});
export type SubscriptionList = z.infer<typeof subscriptionListSchema>;
export const parseSubscriptionList = (json: unknown) => subscriptionListSchema.parse(json);

// ─── Payments ledger (docs/DECISIONS.md SA-17, SA-18) ────────────────────────
const paymentRowSchema = z.object({
  payment_id: z.string(),
  created_at: iso,
  restaurant_id: z.string(),
  restaurant_name: z.string(),
  slug: z.string(),
  purpose: z.enum(PAYMENT_PURPOSES),
  plan_code: z.string().nullable(),
  plan_name: z.string().nullable(),
  billing_cycle: billingCycle.nullable(),
  base_paise: z.number(),
  gst_paise: z.number(),
  amount_paise: z.number(),
  method: z.enum(PAYMENT_METHODS),
  razorpay_payment_id: z.string().nullable(),
  period_start: isoOrNull,
  period_end: isoOrNull,
  recorded_by: z.string().nullable(),
  notes: z.string().nullable(),
  list_price_paise: z.number().nullable(),
  discount_paise: z.number().nullable(),
});
const paymentListSchema = z.object({
  page: z.number(),
  page_size: z.number(),
  total: z.number(),
  totals: z.object({
    count: z.number(),
    base_paise: z.number(),
    gst_paise: z.number(),
    amount_paise: z.number(),
    subscription_base_paise: z.number(),
    setup_fee_base_paise: z.number(),
  }),
  rows: z.array(paymentRowSchema),
});
export type PaymentList = z.infer<typeof paymentListSchema>;
export type PaymentRow = z.infer<typeof paymentRowSchema>;
export const parsePaymentList = (json: unknown) => paymentListSchema.parse(json);

/** Who recorded a payment: the team member's email, or Razorpay. */
export function paymentRecordedBy(row: Pick<PaymentRow, 'method' | 'recorded_by'>): string {
  if (row.method === 'autopay' || row.method === 'payment_link') return 'Razorpay';
  return row.recorded_by ?? '—';
}

/** "Growth, monthly"; a setup fee has no plan. */
export function paymentPlanLabel(
  row: Pick<PaymentRow, 'purpose' | 'plan_name' | 'billing_cycle'>,
): string {
  if (row.purpose === 'setup_fee') return PAYMENT_PURPOSE_LABELS.setup_fee;
  if (!row.plan_name) return '—';
  return `${row.plan_name}, ${row.billing_cycle === 'yearly' ? 'yearly' : 'monthly'}`;
}

// ─── Dues (docs/DECISIONS.md SA-19) ──────────────────────────────────────────
export const duesRowSchema = z.object({
  restaurant_id: z.string(),
  name: z.string(),
  slug: z.string(),
  city: z.string().nullable(),
  phone: z.string().nullable(),
  plan_code: z.string(),
  plan_name: z.string(),
  billing_cycle: billingCycle.nullable(),
  status: subscriptionStatus,
  source: z.string().nullable(),
  state: subscriptionState,
  trial_ends_at: isoOrNull,
  current_period_end: isoOrNull,
  grace_until: isoOrNull,
  restriction_at: isoOrNull,
  access_reason: z.string().nullable(),
  razorpay_status: z.string().nullable(),
  autopay: z.boolean(),
  renewal_kind: z.enum(RENEWAL_KINDS),
  due_paise: z.number(),
  last_reminder_kind: z.string().nullable(),
  last_reminder_at: isoOrNull,
});
const duesListSchema = z.object({
  bucket: z.enum(DUES_BUCKETS),
  days: z.union([z.literal(7), z.literal(30)]),
  page: z.number(),
  page_size: z.number(),
  total: z.number(),
  counts: z.record(z.enum(DUES_BUCKETS), z.number()),
  // Renewals of each kind in the chosen window, across every page.
  kinds: z.record(z.enum(RENEWAL_KINDS), z.number()),
  expected: z.object({
    autopay_paise: z.number(),
    autopay_count: z.number(),
    needs_payment_paise: z.number(),
    needs_payment_count: z.number(),
  }),
  rows: z.array(duesRowSchema),
});
export type DuesList = z.infer<typeof duesListSchema>;
export type DuesRow = z.infer<typeof duesRowSchema>;
export const parseDuesList = (json: unknown) => duesListSchema.parse(json);

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
    business_day_start_hour: z.number(),
    status: restaurantStatus,
    suspended_reason: z.string().nullable(),
    acquisition_channel: z.enum(ACQUISITION_CHANNELS).nullable(),
    created_at: iso,
  }),
  // As the restaurants list has them (docs/DECISIONS.md SA-34).
  state: subscriptionState,
  health: z.enum(HEALTHS),
  last_active: isoOrNull,
  account_manager: z.object({ user_id: z.string(), email: z.string().nullable() }).nullable(),
  tags: z.array(tagSchema),
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
      razorpay_status: z.string().nullable(),
      next_plan_name: z.string().nullable(),
      next_billing_cycle: billingCycle.nullable(),
      cancel_reason: z.enum(CANCEL_REASONS).nullable(),
      cancel_reason_detail: z.string().nullable(),
      max_tables: z.number().nullable(),
      max_staff: z.number().nullable(),
    })
    .nullable(),
  // Whether this admin sees money; payments are empty without it.
  money: z.boolean(),
  payments: z.array(
    z.object({
      payment_id: z.string(),
      source: z.string(),
      purpose: z.enum(PAYMENT_PURPOSES),
      amount_paise: z.number(),
      base_paise: z.number(),
      gst_paise: z.number(),
      manual_mode: z.enum(MANUAL_MODES).nullable(),
      plan_name: z.string().nullable(),
      billing_cycle: billingCycle.nullable(),
      razorpay_payment_id: z.string().nullable(),
      recorded_by: z.string().nullable(),
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
    last_order_at: isoOrNull,
    bills: z.number(),
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
export { FEATURE_LABELS } from '@/features/plans/plan-features';

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

const shortDateFormat = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
  timeZone: DEFAULT_TIMEZONE,
  day: 'numeric',
  month: 'short',
});

/** "13 Nov", India time. */
export function formatShortDate(value: string): string {
  return shortDateFormat.format(new Date(value));
}

/** The last day a period covers: its end is the start of the next business day. */
export function periodLastDay(end: string): string {
  return new Date(new Date(end).getTime() - 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The first day a new subscription payment would pay for ('YYYY-MM-DD',
 * India): after the trial or the paid period when either still runs,
 * otherwise today.
 */
export function firstUnpaidDay(
  subscription: {
    status: SubscriptionStatus;
    restrictionAt: string | null;
    currentPeriodEnd: string | null;
  } | null,
  now = new Date(),
): string {
  const today = todayInIndia(now);
  let covered: string | null = null;
  if (subscription?.status === 'trialing') covered = subscription.restrictionAt;
  else if (subscription?.status === 'active') covered = subscription.currentPeriodEnd;
  const day = covered ? todayInIndia(new Date(covered)) : today;
  return day > today ? day : today;
}

/** Whole days from now until a time, never below 0. */
export function daysUntil(value: string, now = new Date()): number {
  return Math.max(0, Math.ceil((new Date(value).getTime() - now.getTime()) / 86_400_000));
}

/** Whole days from a time until now, never below 0. */
export function daysSince(value: string, now = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(value).getTime()) / 86_400_000));
}

/** A period whose end is the start of the next business day, shown with its last day. */
export function formatPeriod(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  return `${formatDate(start)} – ${formatDate(periodLastDay(end))}`;
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
