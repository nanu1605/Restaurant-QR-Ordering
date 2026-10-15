import { z } from 'zod';

import { formatPriceInput, parsePriceInput } from '@/features/menu/schemas';
import { firstParam, isDate, type SearchParams } from '@/lib/date-range';

/**
 * The standee tracker (docs/SUPER_ADMIN_PLAN.md 14c, docs/DECISIONS.md
 * SA-84, SA-85): one record per restaurant, its status the last step with a
 * date. Cost is money: null without money.view.
 */

export const STANDEE_STEPS = ['printed', 'dispatched', 'delivered', 'installed'] as const;
export type StandeeStep = (typeof STANDEE_STEPS)[number];
export const STANDEE_STATUSES = ['to_print', ...STANDEE_STEPS] as const;
export type StandeeStatus = (typeof STANDEE_STATUSES)[number];
export const STANDEE_TABS = ['open', 'not_started', ...STANDEE_STATUSES] as const;
export type StandeeTab = (typeof STANDEE_TABS)[number];

export const STANDEE_STATUS_LABELS: Record<StandeeStatus | 'not_started', string> = {
  not_started: 'Not started',
  to_print: 'To print',
  printed: 'Printed',
  dispatched: 'Dispatched',
  delivered: 'Delivered',
  installed: 'Installed',
};
export const STANDEE_TAB_LABELS: Record<StandeeTab, string> = {
  open: 'Open',
  ...STANDEE_STATUS_LABELS,
};

const STEP_KEYS = {
  printed: 'printed_on',
  dispatched: 'dispatched_on',
  delivered: 'delivered_on',
  installed: 'installed_on',
} as const;

/** The step after a status, to mark with today's date; null once installed. */
export function nextStep(status: StandeeStatus | 'not_started'): StandeeStep | 'start' | null {
  if (status === 'not_started') return 'start';
  if (status === 'installed') return null;
  return STANDEE_STEPS[STANDEE_STATUSES.indexOf(status)];
}

export const NEXT_STEP_LABELS: Record<StandeeStep | 'start', string> = {
  start: 'Start',
  printed: 'Mark printed',
  dispatched: 'Mark dispatched',
  delivered: 'Mark delivered',
  installed: 'Mark installed',
};

/** platform_save_standees' patch for marking a step today (India); 'start' makes the record. */
export function stepPatch(step: StandeeStep | 'start', today: string) {
  return step === 'start' ? {} : { [STEP_KEYS[step]]: today };
}

const dateOrNull = z.string().nullable();
const recordSchema = z.object({
  quantity: z.number(),
  status: z.enum(STANDEE_STATUSES),
  printed_on: dateOrNull,
  dispatched_on: dateOrNull,
  delivered_on: dateOrNull,
  installed_on: dateOrNull,
  vendor: z.string().nullable(),
  cost_paise: z.number().nullable(),
  notes: z.string().nullable(),
  updated_at: z.string(),
});
export type StandeeRecord = z.infer<typeof recordSchema>;

const detailSchema = z.object({
  standees: recordSchema.nullable(),
  tables_active: z.number(),
  setup_fee: z.object({ paid_at: z.string(), amount_paise: z.number().nullable() }).nullable(),
});
export type StandeeDetail = z.infer<typeof detailSchema>;
export const parseStandeeDetail = (json: unknown) => detailSchema.parse(json);

const rowSchema = recordSchema.omit({ status: true, notes: true, updated_at: true }).extend({
  restaurant_id: z.string(),
  name: z.string(),
  slug: z.string(),
  city: z.string().nullable(),
  status: z.enum(['not_started', ...STANDEE_STATUSES]),
  setup_fee_paid_at: z.string().nullable(),
  since: z.string(),
});
export type StandeeRow = z.infer<typeof rowSchema>;

const listSchema = z.object({
  page: z.number(),
  page_size: z.number(),
  total: z.number(),
  counts: z.record(z.enum(STANDEE_TABS), z.number()),
  rows: z.array(rowSchema),
});
export type StandeeList = z.infer<typeof listSchema>;
export const parseStandeeList = (json: unknown) => listSchema.parse(json);

export type StandeeFilters = { status?: Exclude<StandeeTab, 'open'>; page: number };

export function readStandeeFilters(params: SearchParams): StandeeFilters {
  const status = firstParam(params, 'status');
  const page = Number(firstParam(params, 'page'));
  return {
    status:
      STANDEE_TABS.includes(status as StandeeTab) && status !== 'open'
        ? (status as Exclude<StandeeTab, 'open'>)
        : undefined,
    page: Number.isInteger(page) && page >= 1 && page <= 10000 ? page : 1,
  };
}

// ─── The form ────────────────────────────────────────────────────────────────
const optionalDate = z.string().refine((text) => text === '' || isDate(text), 'Choose a date.');

export const standeeSchema = z
  .object({
    quantity: z
      .string()
      .trim()
      .refine(
        (text) => /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 500,
        'Enter 1 to 500.',
      ),
    printedOn: optionalDate,
    dispatchedOn: optionalDate,
    deliveredOn: optionalDate,
    installedOn: optionalDate,
    vendor: z.string().trim().max(120, 'Use 120 characters or fewer.'),
    notes: z.string().trim().max(1000, 'Use 1000 characters or fewer.'),
    cost: z
      .string()
      .trim()
      .refine((text) => text === '' || parsePriceInput(text) !== null, 'Enter rupees, e.g. 1200.'),
    // India's today: no step is ahead of it.
    today: z.string(),
  })
  .superRefine((value, ctx) => {
    const dates = [value.printedOn, value.dispatchedOn, value.deliveredOn, value.installedOn];
    const paths = ['printedOn', 'dispatchedOn', 'deliveredOn', 'installedOn'];
    dates.forEach((date, index) => {
      if (!date) return;
      if (date > value.today) {
        ctx.addIssue({ code: 'custom', path: [paths[index]], message: 'Not after today.' });
      } else if (dates.slice(0, index).some((earlier) => earlier && earlier > date)) {
        ctx.addIssue({
          code: 'custom',
          path: [paths[index]],
          message: 'On or after the steps before it.',
        });
      }
    });
  });
export type StandeeInput = z.input<typeof standeeSchema>;

/**
 * The form as platform_save_standees takes it: the record for those who
 * manage restaurants, the cost for those who record money (SA-85).
 */
export function standeePayload(
  value: z.output<typeof standeeSchema>,
  can: { manage: boolean; record: boolean },
) {
  return {
    ...(can.manage && {
      quantity: Number(value.quantity),
      printed_on: value.printedOn || null,
      dispatched_on: value.dispatchedOn || null,
      delivered_on: value.deliveredOn || null,
      installed_on: value.installedOn || null,
      vendor: value.vendor || null,
      notes: value.notes || null,
    }),
    ...(can.record && { cost_paise: value.cost ? parsePriceInput(value.cost) : null }),
  };
}

export function standeeForm(detail: StandeeDetail, today: string): StandeeInput {
  const record = detail.standees;
  return {
    quantity: String(record?.quantity ?? Math.max(1, detail.tables_active)),
    printedOn: record?.printed_on ?? '',
    dispatchedOn: record?.dispatched_on ?? '',
    deliveredOn: record?.delivered_on ?? '',
    installedOn: record?.installed_on ?? '',
    vendor: record?.vendor ?? '',
    notes: record?.notes ?? '',
    cost: record?.cost_paise == null ? '' : formatPriceInput(record.cost_paise),
    today,
  };
}
