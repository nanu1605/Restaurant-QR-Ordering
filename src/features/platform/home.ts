import { z } from 'zod';

import { ONBOARDING_STEPS } from '@/features/onboarding/onboarding';
import {
  SUPPORT_STATUSES,
  SUPPORT_TOPIC_LABELS,
  SUPPORT_TOPICS,
  type SupportTopic,
} from '@/features/support/support';
import { formatINR } from '@/lib/money';

import {
  ACQUISITION_CHANNEL_LABELS,
  duesRowSchema,
  formatShortDate,
  lookalikeSchema,
  PAYMENT_METHOD_LABELS,
  REMINDER_LABELS,
  SUBSCRIPTION_STATE_LABELS,
  type AcquisitionChannel,
  type PaymentMethod,
  type SubscriptionState,
} from './platform';

/**
 * Home (docs/SUPER_ADMIN_PLAN.md 12e, docs/DECISIONS.md SA-27 to SA-30): the
 * shapes of platform_home, platform_needs_attention, platform_activity and
 * platform_alerts, and how each activity item reads.
 */

const iso = z.string();
const isoOrNull = z.string().nullable();

export const HOME_PERIODS = ['today', 'month'] as const;
export type HomePeriod = (typeof HOME_PERIODS)[number];

const homeSchema = z.object({
  period: z.enum(HOME_PERIODS),
  money: z.boolean(),
  restaurants: z.object({
    total: z.number(),
    paid: z.number(),
    trial: z.number(),
    payment_failed: z.number(),
    read_only: z.number(),
    suspended: z.number(),
    cancelled: z.number(),
  }),
  // Null without money.view.
  mrr_paise: z.number().nullable(),
  // The snapshot of the same India date last month; null before history reaches it.
  mrr_month_ago_paise: z.number().nullable(),
  collected: z
    .object({ base_paise: z.number(), gst_paise: z.number(), count: z.number() })
    .nullable(),
  gmv_paise: z.number(),
  orders: z.number(),
  open_tables: z.number(),
  history_starts_on: z.string().nullable(),
  charts: z.object({
    mrr: z.array(z.object({ day: z.string(), mrr_paise: z.number() })).nullable(),
    usage: z.array(z.object({ day: z.string(), gmv_paise: z.number(), orders: z.number() })),
    new_restaurants: z.array(z.object({ week: z.string(), signup: z.number(), team: z.number() })),
  }),
});
export type Home = z.infer<typeof homeSchema>;
export const parseHome = (json: unknown) => homeSchema.parse(json);

// ─── Needs attention ─────────────────────────────────────────────────────────
export const ATTENTION_GROUPS = [
  'payment_failed',
  'trial_ending',
  'needs_payment',
  'new_leads',
  'support_open',
  'stuck_onboarding',
  'inactive',
  'slowing',
  'duplicates',
  'webhooks',
  'cron',
] as const;
export type AttentionGroup = (typeof ATTENTION_GROUPS)[number];
const ATTENTION_GROUP_LABELS: Record<Exclude<AttentionGroup, 'inactive'>, string> = {
  payment_failed: 'Payment failed',
  trial_ending: 'Trial ends in 3 days, no autopay',
  needs_payment: 'Needs a payment within 7 days',
  new_leads: 'Leads not contacted in 24 hours',
  support_open: 'Support requests open over 24 hours',
  stuck_onboarding: 'Stuck in onboarding',
  slowing: 'Orders slowing down',
  duplicates: 'Possible duplicate signups',
  webhooks: 'Failed webhooks',
  cron: 'Failed scheduled steps',
};

/** A group's heading; how long "inactive" is comes from the health settings. */
export function attentionGroupLabel(group: AttentionGroup, inactiveDays: number): string {
  return group === 'inactive'
    ? `No orders in ${inactiveDays} ${inactiveDays === 1 ? 'day' : 'days'}`
    : ATTENTION_GROUP_LABELS[group];
}

const item = <T extends z.ZodType>(data: T) => z.object({ key: z.string(), data }).array();
const count = z.number();
const quietData = z.object({
  restaurant_id: z.string(),
  name: z.string(),
  slug: z.string(),
  city: z.string().nullable(),
  phone: z.string().nullable(),
  health: z.enum(['inactive', 'slowing']),
});

const attentionGroupSchema = z.discriminatedUnion('group', [
  z.object({
    group: z.enum(['payment_failed', 'trial_ending', 'needs_payment']),
    count,
    items: item(duesRowSchema),
  }),
  z.object({
    group: z.literal('new_leads'),
    count,
    items: item(
      z.object({
        lead_id: z.string(),
        name: z.string(),
        restaurant_name: z.string(),
        city: z.string(),
        phone: z.string(),
        created_at: iso,
      }),
    ),
  }),
  z.object({
    group: z.literal('support_open'),
    count,
    items: item(
      z.object({
        request_id: z.string(),
        restaurant_id: z.string(),
        name: z.string(),
        topic: z.enum(SUPPORT_TOPICS),
        status: z.enum(SUPPORT_STATUSES),
        created_at: iso,
      }),
    ),
  }),
  z.object({
    group: z.literal('stuck_onboarding'),
    count,
    items: item(
      z.object({
        restaurant_id: z.string(),
        name: z.string(),
        slug: z.string(),
        city: z.string().nullable(),
        phone: z.string().nullable(),
        next: z.enum(ONBOARDING_STEPS),
        since: iso,
      }),
    ),
  }),
  z.object({ group: z.enum(['inactive', 'slowing']), count, items: item(quietData) }),
  z.object({
    group: z.literal('duplicates'),
    count,
    items: item(
      z.object({
        restaurant_id: z.string(),
        name: z.string(),
        slug: z.string(),
        city: z.string().nullable(),
        created_at: iso,
        matches: z.array(lookalikeSchema),
      }),
    ),
  }),
  z.object({
    group: z.literal('webhooks'),
    count,
    items: item(
      z.object({
        id: z.string(),
        event_type: z.string(),
        received_at: iso,
        error: z.string(),
      }),
    ),
  }),
  z.object({
    group: z.literal('cron'),
    count,
    items: item(
      z.object({
        job: z.string(),
        step: z.string(),
        started_at: iso,
        detail: z.string().nullable(),
      }),
    ),
  }),
]);
const attentionSchema = z.object({
  total: z.number(),
  // platform_settings.health_inactive_days, for the inactive group's heading.
  inactive_days: z.number(),
  groups: z.array(attentionGroupSchema),
});
export type Attention = z.infer<typeof attentionSchema>;
export type AttentionGroupList = Attention['groups'][number];
export const parseAttention = (json: unknown) => attentionSchema.parse(json);

/** Snooze lengths in days (docs/DECISIONS.md SA-28). */
export const SNOOZE_DAYS = [1, 3, 7] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS)[number];

// ─── Activity ────────────────────────────────────────────────────────────────
export const ACTIVITY_KINDS = [
  'signup',
  'onboarded',
  'payment',
  'payment_failed',
  'lapsed',
  'reminder',
  'lead',
  'menu_import',
  'support',
  'note',
  'team',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  signup: 'Signups',
  onboarded: 'Onboarded',
  payment: 'Payments',
  payment_failed: 'Failed payments',
  lapsed: 'Lapsed',
  reminder: 'Reminders',
  lead: 'Leads',
  menu_import: 'Menu imports',
  support: 'Support requests',
  note: 'Notes',
  team: 'Team',
};

/**
 * The kinds an admin may see: money, leads, support requests and the team's
 * actions need their permission.
 */
export function activityKindsFor(can: {
  money: boolean;
  growth: boolean;
  support: boolean;
  audit: boolean;
}): ActivityKind[] {
  return ACTIVITY_KINDS.filter(
    (kind) =>
      (can.money || (kind !== 'payment' && kind !== 'payment_failed')) &&
      (can.growth || kind !== 'lead') &&
      (can.support || kind !== 'support') &&
      (can.audit || kind !== 'team'),
  );
}
/** The kinds that raise an alert (docs/DECISIONS.md SA-30, SA-43). */
export const ALERT_KINDS: readonly ActivityKind[] = [
  'signup',
  'payment',
  'payment_failed',
  'lead',
  'support',
];

const activityItemSchema = z.object({
  key: z.string(),
  kind: z.enum(ACTIVITY_KINDS),
  at: iso,
  restaurant_id: z.string().nullable(),
  restaurant_name: z.string().nullable(),
  actor: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type ActivityItem = z.infer<typeof activityItemSchema>;
const activityPageSchema = z.object({
  items: z.array(activityItemSchema),
  next: z.string().nullable(),
});
export type ActivityPage = z.infer<typeof activityPageSchema>;
export const parseActivityPage = (json: unknown) => activityPageSchema.parse(json);

const alertsSchema = z.object({
  seen_at: isoOrNull,
  unread: z.number(),
  items: z.array(activityItemSchema),
  attention: z.number(),
});
export type Alerts = z.infer<typeof alertsSchema>;
export const parseAlerts = (json: unknown) => alertsSchema.parse(json);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
const number = (value: unknown): number | null => (typeof value === 'number' ? value : null);

// What the team did, in words; anything else reads as its action name.
const TEAM_ACTIONS: Record<string, string> = {
  'restaurant.suspended': 'Suspended',
  'restaurant.unsuspended': 'Unsuspended',
  'subscription.trial_extended': 'Trial extended',
  'subscription.plan_changed': 'Plan changed',
  'subscription.payment_link_sent': 'Payment link sent',
  'staff.password_reset': 'Password reset for a login',
  'support.viewed': 'Support view opened',
  'webhook.reprocessed': 'Webhook run again',
  'plan.updated': 'Plan updated',
  'platform_settings.updated': 'Platform settings changed',
  'restaurant.tags_changed': 'Tags changed',
  'restaurant.account_manager_changed': 'Account manager changed',
  'platform_tag.created': 'Tag created',
  'platform_tag.deleted': 'Tag deleted',
  'support_access.allowed': 'Support access given in person',
  'support_session.started': 'Support session started',
  'support_session.ended': 'Support session ended',
  'restaurant.channel_changed': 'Found us changed',
};

export type ActivityLine = {
  title: string;
  detail: string | null;
  href: string | null;
  /** Before GST, with the GST apart; null without money.view or for no money. */
  amount: { basePaise: number; gstPaise: number } | null;
};

/** How one activity item reads, and where it leads. */
export function activityLine(item: ActivityItem): ActivityLine {
  const { data } = item;
  const restaurant = item.restaurant_id ? `/super/restaurants/${item.restaurant_id}` : null;
  const line = (title: string, detail: string | null = null, href = restaurant): ActivityLine => ({
    title,
    detail,
    href,
    amount: null,
  });
  switch (item.kind) {
    case 'signup': {
      const channel = text(data.channel) as AcquisitionChannel | null;
      return line(
        'New signup',
        [text(data.city), channel && ACQUISITION_CHANNEL_LABELS[channel]]
          .filter(Boolean)
          .join(', ') || null,
      );
    }
    case 'onboarded':
      return line('Onboarded by the team', text(data.city));
    case 'payment': {
      const method = text(data.method) as PaymentMethod | null;
      const base = number(data.base_paise);
      const gst = number(data.gst_paise);
      return {
        title: data.purpose === 'setup_fee' ? 'Setup fee received' : 'Payment received',
        detail:
          [method && PAYMENT_METHOD_LABELS[method], item.actor && `recorded by ${item.actor}`]
            .filter(Boolean)
            .join(', ') || null,
        href: restaurant && `${restaurant}/billing#section-payments`,
        amount: base === null || gst === null ? null : { basePaise: base, gstPaise: gst },
      };
    }
    case 'payment_failed': {
      const grace = text(data.grace_until);
      return line('Payment failed', grace && `Ordering stays on till ${formatShortDate(grace)}`);
    }
    case 'lapsed': {
      const was = text(data.was) as SubscriptionState | null;
      return line('Became read-only', was && `Was ${SUBSCRIPTION_STATE_LABELS[was]}`);
    }
    case 'reminder': {
      const kind = text(data.reminder);
      return line('Reminder emailed', kind && (REMINDER_LABELS[kind] ?? kind));
    }
    case 'lead':
      return line(
        'New lead',
        [text(data.name), text(data.restaurant_name), text(data.city)].filter(Boolean).join(', '),
        `/super/leads/${text(data.lead_id) ?? ''}`,
      );
    case 'menu_import': {
      // menu_imports.imported_counts, as the import's commit writes it.
      const counts = (data.counts ?? {}) as Record<string, unknown>;
      const added = number(counts.items_created);
      const updated = number(counts.items_updated);
      const importId = text(data.import_id);
      return line(
        data.status === 'failed' ? 'Menu import failed' : 'Menu imported',
        [
          added !== null && `${added} ${added === 1 ? 'dish' : 'dishes'} added`,
          updated ? `${updated} updated` : null,
        ]
          .filter(Boolean)
          .join(', ') || null,
        restaurant && importId && `${restaurant}/menu-import/${importId}`,
      );
    }
    case 'support': {
      const topic = text(data.topic) as SupportTopic | null;
      const message = text(data.message) ?? '';
      return line(
        'Support request',
        [topic && SUPPORT_TOPIC_LABELS[topic], data.more === true ? `${message}…` : message]
          .filter(Boolean)
          .join(': ') || null,
        `/super/support/${text(data.request_id) ?? ''}`,
      );
    }
    case 'note': {
      const body = text(data.body) ?? '';
      return line(
        data.pinned === true ? 'Pinned note' : 'Note',
        // The stream carries the first 200 characters.
        data.more === true ? `${body}…` : body,
        restaurant && `${restaurant}/notes`,
      );
    }
    case 'team': {
      const action = text(data.action) ?? '';
      return line(
        TEAM_ACTIONS[action] ?? action,
        [item.actor, text(data.reason)].filter(Boolean).join(': ') || null,
      );
    }
  }
}

/** "₹1,000 + GST ₹180", for an amount in the stream. */
export function amountWithGst(amount: { basePaise: number; gstPaise: number }): string {
  return `${formatINR(amount.basePaise, { fraction: 'auto' })} + GST ${formatINR(amount.gstPaise, { fraction: 'auto' })}`;
}

/** MRR against the same day last month: '+8%', or null when there is nothing to compare. */
export function mrrChange(now: number, monthAgo: number | null): number | null {
  if (monthAgo === null || monthAgo === 0) return null;
  return Math.round(((now - monthAgo) / monthAgo) * 100);
}
