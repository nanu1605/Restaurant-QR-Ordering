import { z } from 'zod';

import { MAX_REASON, reasonSchema } from '@/features/orders/schemas';
import { rupeesToPaise, type Paise } from '@/lib/money';
import { Constants } from '@/types/database';

import type { DiscountType, PaymentMode, PaymentStatus } from './bill';

/** Validation for billing actions and forms (spec §10.5, §13.3; docs/DECISIONS.md P5-8, P5-17). */

export const MAX_PAYMENT_ROWS = 10;
export const MAX_REFERENCE = 100;

const RUPEES = /^\d{1,7}(\.\d{1,2})?$/;
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;

/**
 * What the manager typed in the discount box, as the database expects it:
 * paise for a flat discount, basis points for a percentage (max 100%).
 * Null while the text isn't a valid amount yet.
 */
export function discountValue(type: DiscountType, text: string): number | null {
  if (type === 'none') return 0;
  const trimmed = text.trim();
  if (type === 'flat') return RUPEES.test(trimmed) ? rupeesToPaise(trimmed) : null;
  if (!PERCENT.test(trimmed)) return null;
  const bps = rupeesToPaise(trimmed); // two decimals → hundredths, i.e. basis points
  return bps <= 10_000 ? bps : null;
}

export const discountTypeSchema = z.enum(Constants.public.Enums.discount_type);

export const generateBillSchema = z
  .object({
    sessionId: z.uuid(),
    discountType: discountTypeSchema,
    discountValue: z.number().int().min(0).max(1_000_000_000),
    discountReason: z
      .string()
      .trim()
      .max(MAX_REASON, `Keep the reason under ${MAX_REASON} characters.`),
    applyServiceCharge: z.boolean(),
  })
  .refine((v) => v.discountType !== 'percent' || v.discountValue <= 10_000, {
    path: ['discountValue'],
    message: 'A discount can be at most 100%.',
  })
  .refine(
    (v) => v.discountType === 'none' || v.discountValue === 0 || v.discountReason.length > 0,
    {
      path: ['discountReason'],
      message: 'Give a reason for the discount.',
    },
  );

export type GenerateBillInput = z.input<typeof generateBillSchema>;

export const paymentModeSchema = z.enum(Constants.public.Enums.payment_mode);

export const paymentRowSchema = z.object({
  mode: paymentModeSchema,
  amountPaise: z.number().int().min(0),
  reference: z
    .string()
    .trim()
    .max(MAX_REFERENCE, `Keep the reference under ${MAX_REFERENCE} characters.`),
});

export const recordPaymentSchema = z.object({
  billId: z.uuid(),
  payments: z.array(paymentRowSchema).min(1).max(MAX_PAYMENT_ROWS),
});

export type RecordPaymentInput = z.input<typeof recordPaymentSchema>;

/** A payment row as typed in the dialog: the amount in rupees. */
export type PaymentFormRow = { mode: PaymentMode; amount: string; reference: string };

/** Paise for a typed rupee amount, or null while it isn't one. */
export function rupeesInput(text: string): Paise | null {
  const trimmed = text.trim();
  return RUPEES.test(trimmed) ? rupeesToPaise(trimmed) : null;
}

/**
 * Checks typed payment rows against the bill total (the database checks the
 * same): every amount valid, positive unless the bill is ₹0, adding up.
 */
export function checkPayments(
  rows: PaymentFormRow[],
  grandTotalPaise: Paise,
): { ok: true; paidPaise: Paise } | { ok: false; error: string; paidPaise: Paise } {
  let paid = 0;
  for (const row of rows) {
    const amount = rupeesInput(row.amount);
    if (amount === null)
      return { ok: false, error: 'Enter each amount in rupees.', paidPaise: paid };
    if (amount === 0 && (grandTotalPaise > 0 || rows.length > 1)) {
      return { ok: false, error: 'Each payment needs an amount.', paidPaise: paid };
    }
    paid += amount;
  }
  if (paid !== grandTotalPaise)
    return { ok: false, error: 'Payments must add up to the total.', paidPaise: paid };
  return { ok: true, paidPaise: paid };
}

/** Change to give back for cash, or null while less than the total was handed over. */
export function cashChange(receivedPaise: Paise | null, duePaise: Paise): Paise | null {
  if (receivedPaise === null || receivedPaise < duePaise) return null;
  return receivedPaise - duePaise;
}

export const voidBillSchema = z.object({
  billId: z.uuid(),
  reason: reasonSchema,
  reopen: z.boolean(),
});

export type VoidBillInput = z.input<typeof voidBillSchema>;

export const VOID_REASONS = [
  'Wrong table',
  'Wrong dishes',
  'Add more dishes',
  'Duplicate bill',
] as const;

// ─── Total orders filters (URL search params) ─────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TotalOrdersView = 'bills' | 'closed_unbilled';

export type TotalOrdersFilters = {
  from?: string;
  to?: string;
  table_id?: string;
  waiter_id?: string;
  payment_status?: PaymentStatus;
  payment_mode?: PaymentMode;
  invoice?: string;
  show_void?: boolean;
  view?: TotalOrdersView;
  page?: number;
};

type SearchParams = Record<string, string | string[] | undefined>;

function one(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  const text = (Array.isArray(value) ? value[0] : value)?.trim();
  return text ? text : undefined;
}

/**
 * Filters from the page URL for admin_total_orders. Anything malformed is
 * dropped rather than failing the page.
 */
export function totalOrdersFilters(params: SearchParams): TotalOrdersFilters {
  const filters: TotalOrdersFilters = {};
  const from = one(params, 'from');
  const to = one(params, 'to');
  if (from && DATE.test(from)) filters.from = from;
  if (to && DATE.test(to) && filters.from && to >= filters.from) filters.to = to;
  const table = one(params, 'table');
  if (table && UUID.test(table)) filters.table_id = table;
  const waiter = one(params, 'waiter');
  if (waiter && UUID.test(waiter)) filters.waiter_id = waiter;
  const status = one(params, 'payment');
  if (status === 'paid' || status === 'unpaid') filters.payment_status = status;
  const mode = one(params, 'mode');
  if (mode && (Constants.public.Enums.payment_mode as readonly string[]).includes(mode)) {
    filters.payment_mode = mode as PaymentMode;
  }
  const invoice = one(params, 'invoice');
  if (invoice) filters.invoice = invoice.slice(0, 40);
  if (one(params, 'void') === 'hide') filters.show_void = false;
  if (one(params, 'view') === 'closed') filters.view = 'closed_unbilled';
  const page = Number(one(params, 'page'));
  if (Number.isInteger(page) && page > 1 && page <= 10_000) filters.page = page;
  return filters;
}

/** 'YYYY-MM-DD' plus whole days (calendar arithmetic, no timezones). */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export type DatePreset = { key: string; label: string; from: string; to: string };

/** Quick ranges relative to the restaurant's current business day. */
export function datePresets(today: string): DatePreset[] {
  return [
    { key: 'today', label: 'Today', from: today, to: today },
    { key: 'yesterday', label: 'Yesterday', from: addDays(today, -1), to: addDays(today, -1) },
    { key: 'week', label: 'Last 7 days', from: addDays(today, -6), to: today },
    { key: 'month', label: 'This month', from: `${today.slice(0, 8)}01`, to: today },
  ];
}

/** The URL for Total orders with these filters (page resets to 1). */
export function totalOrdersHref(pathname: string, params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** URL params for the current filters, to change one and keep the rest. */
export function filterParams(filters: TotalOrdersFilters): Record<string, string | undefined> {
  return {
    from: filters.from,
    to: filters.to,
    table: filters.table_id,
    waiter: filters.waiter_id,
    payment: filters.payment_status,
    mode: filters.payment_mode,
    invoice: filters.invoice,
    void: filters.show_void === false ? 'hide' : undefined,
    view: filters.view === 'closed_unbilled' ? 'closed' : undefined,
  };
}
