import { z } from 'zod';

import { firstParam, type SearchParams } from '@/lib/date-range';

/**
 * Support requests (docs/SUPER_ADMIN_PLAN.md 13b, docs/DECISIONS.md SA-42,
 * SA-43): what a restaurant asks through Get help, and how the team's inbox
 * reads it.
 */

export const SUPPORT_TOPICS = [
  'billing',
  'menu',
  'printing',
  'orders_tables',
  'staff',
  'other',
] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];
export const SUPPORT_TOPIC_LABELS: Record<SupportTopic, string> = {
  billing: 'Billing',
  menu: 'Menu',
  printing: 'Printing',
  orders_tables: 'Orders and tables',
  staff: 'Staff',
  other: 'Other',
};

export const SUPPORT_STATUSES = ['open', 'in_progress', 'waiting', 'resolved'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
/** The team's words. */
export const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting: 'Waiting on restaurant',
  resolved: 'Resolved',
};
/** The restaurant's words for the same statuses. */
export const OWNER_STATUS_LABELS: Record<SupportStatus, string> = {
  open: 'Received',
  in_progress: 'Being worked on',
  waiting: 'Waiting for you',
  resolved: 'Resolved',
};

export const SUPPORT_PRIORITIES = ['high', 'normal', 'low'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];
export const SUPPORT_PRIORITY_LABELS: Record<SupportPriority, string> = {
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

export const CONTACT_METHODS = ['call', 'whatsapp', 'email'] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];
export const CONTACT_METHOD_LABELS: Record<ContactMethod, string> = {
  call: 'Call',
  whatsapp: 'WhatsApp',
  email: 'Email',
};

/** Screenshots: images up to 5 MB, as the bucket allows. */
export const SCREENSHOT_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const;
export type ScreenshotType = keyof typeof SCREENSHOT_TYPES;
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const SCREENSHOT_BUCKET = 'support-screenshots';

/** Ten digits, without +91 or a leading 0, as the database keeps it. */
export function phoneDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

// The Get help form.
export const supportRequestSchema = z
  .object({
    // A string in the form ('' until chosen), a topic once checked.
    topic: z.string().pipe(z.enum(SUPPORT_TOPICS, 'Choose what it is about.')),
    message: z
      .string()
      .trim()
      .min(1, 'Say what you need help with.')
      .max(2000, 'Keep it under 2,000 characters.'),
    contact_method: z.enum(CONTACT_METHODS, 'Choose how to reach you.'),
    contact: z.string().trim().min(1, 'Add how to reach you.').max(254),
  })
  .superRefine((value, ctx) => {
    if (value.contact_method === 'email') {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.contact)) {
        ctx.addIssue({ code: 'custom', path: ['contact'], message: 'Enter an email address.' });
      }
    } else if (!/^\d{10}$/.test(phoneDigits(value.contact))) {
      ctx.addIssue({
        code: 'custom',
        path: ['contact'],
        message: 'Enter a 10-digit mobile number.',
      });
    }
  });
export type SupportRequestFields = z.input<typeof supportRequestSchema>;
export type SupportRequestInput = z.output<typeof supportRequestSchema>;

// ─── The restaurant's view ───────────────────────────────────────────────────
const ownerRequestSchema = z.object({
  id: z.string(),
  topic: z.enum(SUPPORT_TOPICS),
  message: z.string(),
  has_screenshot: z.boolean(),
  contact_method: z.enum(CONTACT_METHODS),
  contact: z.string(),
  created_by_name: z.string(),
  status: z.enum(SUPPORT_STATUSES),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
  history: z.array(z.object({ at: z.string(), status: z.enum(SUPPORT_STATUSES) })),
});
export type OwnerSupportRequest = z.infer<typeof ownerRequestSchema>;
export const parseOwnerRequests = (json: unknown) => z.array(ownerRequestSchema).parse(json);

// ─── The inbox ───────────────────────────────────────────────────────────────
/** The inbox's status tabs: active is every request not yet resolved. */
export const INBOX_TABS = ['active', 'open', 'in_progress', 'waiting', 'resolved'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];
export const INBOX_TAB_LABELS: Record<InboxTab, string> = {
  active: 'Not resolved',
  ...SUPPORT_STATUS_LABELS,
};

export type InboxFilters = {
  status?: InboxTab;
  /** 'me', 'none' or a team member's user id. */
  assignee?: string;
  priority?: SupportPriority;
  topic?: SupportTopic;
  page: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const oneOf = <T extends string>(value: string | undefined, options: readonly T[]) =>
  options.find((option) => option === value);

/** The inbox's filters from the URL; anything unknown is dropped. */
export function readInboxFilters(params: SearchParams): InboxFilters {
  const assignee = firstParam(params, 'assignee');
  const page = Number(firstParam(params, 'page'));
  return {
    status: oneOf(firstParam(params, 'status'), INBOX_TABS),
    assignee:
      assignee === 'me' || assignee === 'none' || (assignee && UUID.test(assignee))
        ? assignee
        : undefined,
    priority: oneOf(firstParam(params, 'priority'), SUPPORT_PRIORITIES),
    topic: oneOf(firstParam(params, 'topic'), SUPPORT_TOPICS),
    page: Number.isInteger(page) && page >= 1 && page <= 10000 ? page : 1,
  };
}

const inboxRowSchema = z.object({
  id: z.string(),
  restaurant_id: z.string(),
  restaurant_name: z.string(),
  slug: z.string(),
  topic: z.enum(SUPPORT_TOPICS),
  message: z.string(),
  more: z.boolean(),
  created_by_name: z.string(),
  status: z.enum(SUPPORT_STATUSES),
  priority: z.enum(SUPPORT_PRIORITIES),
  assignee: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  resolved_at: z.string().nullable(),
});
export type InboxRow = z.infer<typeof inboxRowSchema>;
const inboxSchema = z.object({
  page: z.number(),
  page_size: z.number(),
  total: z.number(),
  counts: z.object({
    active: z.number(),
    open: z.number(),
    in_progress: z.number(),
    waiting: z.number(),
    resolved: z.number(),
  }),
  rows: z.array(inboxRowSchema),
});
export type Inbox = z.infer<typeof inboxSchema>;
export const parseInbox = (json: unknown) => inboxSchema.parse(json);

const requestSchema = z.object({
  id: z.string(),
  restaurant_id: z.string(),
  restaurant_name: z.string(),
  slug: z.string(),
  city: z.string().nullable(),
  restaurant_phone: z.string().nullable(),
  topic: z.enum(SUPPORT_TOPICS),
  message: z.string(),
  screenshot_path: z.string().nullable(),
  contact_method: z.enum(CONTACT_METHODS),
  contact: z.string(),
  context: z.object({
    page: z.string().optional(),
    app_version: z.string().optional(),
    browser: z.string().optional(),
  }),
  created_by_name: z.string(),
  created_by_role: z.string(),
  created_by_email: z.string().nullable(),
  status: z.enum(SUPPORT_STATUSES),
  priority: z.enum(SUPPORT_PRIORITIES),
  assignee_id: z.string().nullable(),
  assignee: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  resolved_at: z.string().nullable(),
  events: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['status', 'priority', 'assignee', 'note']),
      at: z.string(),
      actor: z.string().nullable(),
      from: z.string().nullable(),
      to: z.string().nullable(),
      body: z.string().nullable(),
    }),
  ),
});
export type SupportRequest = z.infer<typeof requestSchema>;
export type SupportEvent = SupportRequest['events'][number];
export const parseSupportRequest = (json: unknown) => requestSchema.parse(json);

// An internal note on a request.
export const supportNoteSchema = z.object({
  body: z.string().trim().min(1, 'Write the note.').max(2000, 'Keep it under 2,000 characters.'),
});
export type SupportNoteInput = z.infer<typeof supportNoteSchema>;

/** One change on a request's history, in words. */
export function eventLine(event: SupportEvent): string {
  switch (event.kind) {
    case 'status':
      return `Status: ${label(SUPPORT_STATUS_LABELS, event.from)} to ${label(SUPPORT_STATUS_LABELS, event.to)}`;
    case 'priority':
      return `Priority: ${label(SUPPORT_PRIORITY_LABELS, event.from)} to ${label(SUPPORT_PRIORITY_LABELS, event.to)}`;
    case 'assignee':
      return event.to ? `Assigned to ${event.to}` : 'Unassigned';
    case 'note':
      return 'Internal note';
  }
}

const label = <K extends string>(labels: Record<K, string>, value: string | null) =>
  value && value in labels ? labels[value as K] : (value ?? '—');

/** Hours since a request came in, for the inbox's Age column: "3 h", "2 d". */
export function requestAge(createdAt: string, now = Date.now()): string {
  const hours = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 3_600_000));
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}
