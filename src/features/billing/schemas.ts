import { z } from 'zod';

import { MAX_REASON, reasonSchema } from '@/features/orders/schemas';
import { firstParam, readDateRange, type SearchParams } from '@/lib/date-range';
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
    /** The grand total the manager confirmed (docs/DECISIONS.md P5-14). */
    expectedGrandTotalPaise: z.number().int().min(0),
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

/**
 * Filters from the page URL for admin_total_orders, plus a note when the
 * dates had to be changed. Anything malformed is dropped rather than failing
 * the page; a range longer than a year is cut to a year.
 */
export function readTotalOrdersParams(params: SearchParams): {
  filters: TotalOrdersFilters;
  notice: string | null;
} {
  const { range, notice } = readDateRange(params, 'Total orders');
  const filters: TotalOrdersFilters = { ...range };
  const table = firstParam(params, 'table');
  if (table && UUID.test(table)) filters.table_id = table;
  const waiter = firstParam(params, 'waiter');
  if (waiter && UUID.test(waiter)) filters.waiter_id = waiter;
  const status = firstParam(params, 'payment');
  if (status === 'paid' || status === 'unpaid') filters.payment_status = status;
  const mode = firstParam(params, 'mode');
  if (mode && (Constants.public.Enums.payment_mode as readonly string[]).includes(mode)) {
    filters.payment_mode = mode as PaymentMode;
  }
  const invoice = firstParam(params, 'invoice');
  if (invoice) filters.invoice = invoice.slice(0, 40);
  if (firstParam(params, 'void') === 'hide') filters.show_void = false;
  if (firstParam(params, 'view') === 'closed') filters.view = 'closed_unbilled';
  const page = Number(firstParam(params, 'page'));
  if (Number.isInteger(page) && page > 1 && page <= 10_000) filters.page = page;
  return { filters, notice };
}

export function totalOrdersFilters(params: SearchParams): TotalOrdersFilters {
  return readTotalOrdersParams(params).filters;
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
