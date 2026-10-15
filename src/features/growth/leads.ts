import { z } from 'zod';

import {
  ACQUISITION_CHANNEL_LABELS,
  formatDateTime,
  type AcquisitionChannel,
} from '@/features/platform/platform';
import { phoneDigits } from '@/features/support/support';
import { firstParam, type SearchParams } from '@/lib/date-range';

/** The leads pipeline (docs/SUPER_ADMIN_PLAN.md 13d, docs/DECISIONS.md SA-53 to SA-57). */

export const LEAD_STAGES = [
  'new',
  'contacted',
  'demo_scheduled',
  'demo_done',
  'trial',
  'won',
  'lost',
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  new: 'New',
  contacted: 'Contacted',
  demo_scheduled: 'Demo scheduled',
  demo_done: 'Demo done',
  trial: 'Trial',
  won: 'Won',
  lost: 'Lost',
};
/** New to Trial: still in play. */
export const OPEN_STAGES = ['new', 'contacted', 'demo_scheduled', 'demo_done', 'trial'] as const;

export const LEAD_TABS = ['open', ...LEAD_STAGES, 'all'] as const;
export type LeadTab = (typeof LEAD_TABS)[number];
export const LEAD_TAB_LABELS: Record<LeadTab, string> = {
  open: 'Open',
  ...LEAD_STAGE_LABELS,
  all: 'All',
};

export const LOST_REASONS = [
  'price',
  'not_interested',
  'other_system',
  'no_response',
  'closed_down',
  'other',
] as const;
export type LostReason = (typeof LOST_REASONS)[number];
export const LOST_REASON_LABELS: Record<LostReason, string> = {
  price: 'Price',
  not_interested: 'Not interested',
  other_system: 'Using another system',
  no_response: 'No response',
  closed_down: 'Closed down',
  other: 'Other',
};

/** How a lead came: a demo request on the website, or one the team added by hand. */
export const LEAD_CHANNELS = [
  'website_lead',
  'field_visit',
  'referral',
  'phone',
  'whatsapp',
  'social',
  'other',
] as const satisfies readonly AcquisitionChannel[];
export type LeadChannel = (typeof LEAD_CHANNELS)[number];
export const HAND_CHANNELS = LEAD_CHANNELS.filter(
  (channel): channel is Exclude<LeadChannel, 'website_lead'> => channel !== 'website_lead',
);
export const leadChannelLabel = (channel: LeadChannel) => ACQUISITION_CHANNEL_LABELS[channel];

export const LEAD_DUE = ['overdue', 'today'] as const;
export type LeadDue = (typeof LEAD_DUE)[number];
export const LEAD_DUE_LABELS: Record<LeadDue, string> = {
  overdue: 'Overdue',
  today: 'Due by tonight',
};

// ─── Filters ─────────────────────────────────────────────────────────────────
export type LeadFilters = {
  stage?: LeadTab;
  /** 'me', 'none' or a team member's user id. */
  assignee?: string;
  channel?: LeadChannel;
  due?: LeadDue;
  q?: string;
  page: number;
  /** The board instead of the table. */
  view?: 'board';
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const oneOf = <T extends string>(value: string | undefined, options: readonly T[]) =>
  options.find((option) => option === value);

/** The pipeline's filters from the URL; anything unknown is dropped. */
export function readLeadFilters(params: SearchParams): LeadFilters {
  const assignee = firstParam(params, 'assignee');
  const page = Number(firstParam(params, 'page'));
  return {
    stage: oneOf(firstParam(params, 'stage'), LEAD_TABS),
    assignee:
      assignee === 'me' || assignee === 'none' || (assignee && UUID.test(assignee))
        ? assignee
        : undefined,
    channel: oneOf(firstParam(params, 'channel'), LEAD_CHANNELS),
    due: oneOf(firstParam(params, 'due'), LEAD_DUE),
    q: firstParam(params, 'q')?.slice(0, 80),
    page: Number.isInteger(page) && page >= 1 && page <= 10000 ? page : 1,
    view: firstParam(params, 'view') === 'board' ? 'board' : undefined,
  };
}

// ─── Rows ────────────────────────────────────────────────────────────────────
const sourceSchema = z.record(z.string(), z.string()).nullable();

const leadRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  restaurant_name: z.string(),
  city: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  plan_code: z.string().nullable(),
  message: z.string().nullable(),
  more: z.boolean(),
  source: sourceSchema,
  channel: z.enum(LEAD_CHANNELS),
  stage: z.enum(LEAD_STAGES),
  lost_reason: z.enum(LOST_REASONS).nullable(),
  assignee_id: z.string().nullable(),
  assignee: z.string().nullable(),
  follow_up_at: z.string().nullable(),
  demo_at: z.string().nullable(),
  restaurant_id: z.string().nullable(),
  restaurant: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type LeadRow = z.infer<typeof leadRowSchema>;

const countsSchema = z.object(
  Object.fromEntries(LEAD_TABS.map((tab) => [tab, z.number()])) as Record<LeadTab, z.ZodNumber>,
);
const leadListSchema = z.object({
  page: z.number().optional(),
  page_size: z.number().optional(),
  total: z.number().optional(),
  counts: countsSchema,
  rows: z.array(leadRowSchema),
});
export type LeadList = z.infer<typeof leadListSchema>;
export const parseLeadList = (json: unknown) => leadListSchema.parse(json);

const matchesSchema = z.object({
  restaurants: z.array(
    z.object({ id: z.string(), name: z.string(), slug: z.string(), city: z.string().nullable() }),
  ),
  leads: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      restaurant_name: z.string(),
      city: z.string(),
      stage: z.enum(LEAD_STAGES),
      created_at: z.string(),
    }),
  ),
});
export type LeadMatches = z.infer<typeof matchesSchema>;
export const parseLeadMatches = (json: unknown) => matchesSchema.parse(json);

export const LEAD_EVENT_KINDS = [
  'stage',
  'assignee',
  'follow_up',
  'demo',
  'restaurant',
  'note',
] as const;
const eventSchema = z.object({
  id: z.string(),
  kind: z.enum(LEAD_EVENT_KINDS),
  actor: z.string().nullable(),
  automatic: z.boolean(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  from_label: z.string().nullable(),
  to_label: z.string().nullable(),
  body: z.string().nullable(),
  at: z.string(),
});
export type LeadEvent = z.infer<typeof eventSchema>;

const leadSchema = leadRowSchema.extend({
  restaurant: z
    .object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      city: z.string().nullable(),
      state: z.string(),
    })
    .nullable(),
  matches: matchesSchema,
  events: z.array(eventSchema),
});
export type Lead = z.infer<typeof leadSchema>;
export const parseLead = (json: unknown) => leadSchema.parse(json);

// ─── Lines ───────────────────────────────────────────────────────────────────
/** A stage as the history keeps it; Lost with its reason ('lost:price'). */
function stageLabel(value: string | null): string {
  if (!value) return '—';
  const [stage, reason] = value.split(':');
  const label = LEAD_STAGE_LABELS[stage as LeadStage] ?? stage;
  if (!reason) return label;
  return `${label} (${(LOST_REASON_LABELS[reason as LostReason] ?? reason).toLowerCase()})`;
}

/** One change in a lead's history (notes are shown on their own). */
export function leadEventLine(event: LeadEvent): string {
  const who = event.automatic
    ? 'automatically'
    : event.actor
      ? `by ${event.actor}`
      : 'by a former team member';
  switch (event.kind) {
    case 'stage':
      return `${stageLabel(event.from)} to ${stageLabel(event.to)}, ${who}`;
    case 'assignee':
      return event.to
        ? `Assigned to ${event.to_label ?? 'a former team member'}, ${who}`
        : `No one assigned, ${who}`;
    case 'follow_up':
      return event.to
        ? `Follow-up set for ${formatDateTime(event.to)}, ${who}`
        : `Follow-up cleared, ${who}`;
    case 'demo':
      return event.to ? `Demo set for ${formatDateTime(event.to)}, ${who}` : `Demo cleared, ${who}`;
    case 'restaurant':
      return event.to
        ? `Linked to ${event.to_label ?? 'a closed restaurant'}, ${who}${event.automatic ? ' (same mobile)' : ''}`
        : `Unlinked from ${event.from_label ?? 'a restaurant'}, ${who}`;
    case 'note':
      return event.body ?? '';
  }
}

/** A follow-up time that has passed, for a lead still in play. */
export function followUpOverdue(lead: Pick<LeadRow, 'follow_up_at' | 'stage'>, now = new Date()) {
  return (
    !!lead.follow_up_at &&
    (OPEN_STAGES as readonly string[]).includes(lead.stage) &&
    new Date(lead.follow_up_at) < now
  );
}

// ─── India times in a datetime-local field ──────────────────────────────────
const IST_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** A time as a datetime-local value, India time: '2026-10-16T15:30'. */
export function toIndiaInput(iso: string | null): string {
  if (!iso) return '';
  const part = Object.fromEntries(
    IST_PARTS.formatToParts(new Date(iso)).map(({ type, value }) => [type, value]),
  );
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}`;
}

/** A datetime-local value read as India time, with its offset; null when empty or malformed. */
export function fromIndiaInput(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00+05:30` : null;
}

// ─── Adding a lead by hand ──────────────────────────────────────────────────
const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter the ${what}.`)
    .max(max, `Keep the ${what} under ${max + 1} characters.`);

export const newLeadSchema = z.object({
  name: text(80, 'name'),
  restaurantName: text(120, 'restaurant’s name'),
  city: text(60, 'city'),
  phone: z
    .string()
    .transform(phoneDigits)
    .pipe(z.string().regex(/^[0-9]{10}$/, 'Enter a 10-digit mobile number.')),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, 'Check the email.')
    .refine((value) => value === '' || /^[^@\s]+@[^@\s]+$/.test(value), 'Check the email.'),
  channel: z.enum(HAND_CHANNELS, 'Choose how they came.'),
  stage: z.enum(['new', 'contacted']),
  message: z.string().trim().max(1000, 'Keep the note under 1,001 characters.'),
  /** '' for no one. */
  assignee: z.union([z.literal(''), z.uuid()]),
});
export type NewLeadInput = z.input<typeof newLeadSchema>;

// ─── Unfinished signups (SA-57) ─────────────────────────────────────────────
export const SIGNUP_STEPS = ['code_sent', 'resent', 'wrong_code', 'locked', 'expired'] as const;
export type SignupStep = (typeof SIGNUP_STEPS)[number];
export const SIGNUP_STEP_LABELS: Record<SignupStep, string> = {
  code_sent: 'Code sent, not entered',
  resent: 'Asked for a new code',
  wrong_code: 'Entered a wrong code',
  locked: 'Locked out after 5 wrong codes',
  expired: 'Code ran out',
};

const unfinishedSchema = z.object({
  total: z.number(),
  rows: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      owner_name: z.string().nullable(),
      phone: z.string().nullable(),
      restaurant_name: z.string().nullable(),
      city: z.string().nullable(),
      plan_code: z.string().nullable(),
      cycle: z.string().nullable(),
      step: z.enum(SIGNUP_STEPS),
      lead_id: z.string().nullable(),
      created_at: z.string(),
      deleted_at: z.string(),
    }),
  ),
});
export type UnfinishedSignups = z.infer<typeof unfinishedSchema>;
export const parseUnfinishedSignups = (json: unknown) => unfinishedSchema.parse(json);
