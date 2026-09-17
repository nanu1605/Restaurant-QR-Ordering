import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type { FoodType } from '@/components/shared/food-type-mark';
import { ORDER_ITEM_STATUSES, type OrderItemStatus } from '@/lib/order-status';
import { Constants, type Database } from '@/types/database';

/**
 * Bills as the billing screens read them (spec §8.6, §11, §13.3): the live
 * draft from admin_preview_bill, stored bills from admin_get_bill (and the
 * sample bill, same shape), open tables to bill and Total orders. Parsed with
 * zod so schema drift fails loudly; money stays integer paise.
 */

type Enums = Database['public']['Enums'];
export type DiscountType = Enums['discount_type'];
export type DocumentType = Enums['document_type'];
export type GstMode = Enums['gst_mode'];
export type PaymentMode = Enums['payment_mode'];
export type PaymentStatus = Enums['payment_status'];
export type BillStatus = Enums['bill_status'];
export type PaperWidth = Enums['paper_width'];

const paise = z.number().int();

export type BillLine = {
  name: string;
  variant: string | null;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
  foodType: FoodType;
};

const lineJson = z
  .object({
    name: z.string(),
    variant: z.string().nullable(),
    qty: z.number().int(),
    unit_price_paise: paise,
    line_total_paise: paise,
    food_type: z.enum(Constants.public.Enums.food_type),
  })
  .transform((l): BillLine => ({
    name: l.name,
    variant: l.variant,
    quantity: l.qty,
    unitPricePaise: l.unit_price_paise,
    lineTotalPaise: l.line_total_paise,
    foodType: l.food_type,
  }));

export type BillTotals = {
  subtotalPaise: number;
  discountPaise: number;
  serviceChargePaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  totalTaxPaise: number;
  roundOffPaise: number;
  grandTotalPaise: number;
};

const totalsShape = {
  subtotal_paise: paise,
  discount_paise: paise,
  service_charge_paise: paise,
  taxable_paise: paise,
  cgst_paise: paise,
  sgst_paise: paise,
  total_tax_paise: paise,
  round_off_paise: paise,
  grand_total_paise: paise,
};

function totalsFrom(t: z.infer<z.ZodObject<typeof totalsShape>>): BillTotals {
  return {
    subtotalPaise: t.subtotal_paise,
    discountPaise: t.discount_paise,
    serviceChargePaise: t.service_charge_paise,
    taxablePaise: t.taxable_paise,
    cgstPaise: t.cgst_paise,
    sgstPaise: t.sgst_paise,
    totalTaxPaise: t.total_tax_paise,
    roundOffPaise: t.round_off_paise,
    grandTotalPaise: t.grand_total_paise,
  };
}

// ─── Draft (bill builder) ─────────────────────────────────────────────────────

export type UnservedDish = {
  name: string;
  variant: string | null;
  quantity: number;
  status: OrderItemStatus;
};

export type BillDraft = {
  session: { id: string; tableLabel: string; openedAt: string };
  waiter: { id: string; name: string } | null;
  /** The restaurant has waiter profiles and this table has no waiter (spec §10.7). */
  waiterRequired: boolean;
  waitingCount: number;
  unserved: UnservedDish[];
  lines: BillLine[];
  documentType: DocumentType;
  discountType: DiscountType;
  discountValue: number;
  applyServiceCharge: boolean;
  settings: {
    gstMode: GstMode;
    gstRateBps: number;
    pricesIncludeTax: boolean;
    serviceChargeEnabled: boolean;
    serviceChargeBps: number;
    discounts: boolean;
  };
  totals: BillTotals;
};

const draftJson = z
  .object({
    session: z.object({ id: z.string(), table_label: z.string(), opened_at: z.string() }),
    waiter: z.object({ id: z.string(), name: z.string() }).nullable(),
    waiter_required: z.boolean(),
    waiting_count: z.number().int(),
    unserved: z.array(
      z.object({
        name: z.string(),
        variant: z.string().nullable(),
        quantity: z.number().int(),
        status: z.enum(ORDER_ITEM_STATUSES),
      }),
    ),
    lines: z.array(lineJson),
    document_type: z.enum(Constants.public.Enums.document_type),
    discount_type: z.enum(Constants.public.Enums.discount_type),
    discount_value: z.number().int(),
    apply_service_charge: z.boolean(),
    settings: z.object({
      gst_mode: z.enum(Constants.public.Enums.gst_mode),
      gst_rate_bps: z.number().int(),
      prices_include_tax: z.boolean(),
      service_charge_enabled: z.boolean(),
      service_charge_bps: z.number().int(),
      discounts: z.boolean(),
    }),
    totals: z.object(totalsShape),
  })
  .transform((d): BillDraft => ({
    session: { id: d.session.id, tableLabel: d.session.table_label, openedAt: d.session.opened_at },
    waiter: d.waiter,
    waiterRequired: d.waiter_required,
    waitingCount: d.waiting_count,
    unserved: d.unserved,
    lines: d.lines,
    documentType: d.document_type,
    discountType: d.discount_type,
    discountValue: d.discount_value,
    applyServiceCharge: d.apply_service_charge,
    settings: {
      gstMode: d.settings.gst_mode,
      gstRateBps: d.settings.gst_rate_bps,
      pricesIncludeTax: d.settings.prices_include_tax,
      serviceChargeEnabled: d.settings.service_charge_enabled,
      serviceChargeBps: d.settings.service_charge_bps,
      discounts: d.settings.discounts,
    },
    totals: totalsFrom(d.totals),
  }));

export function parseBillDraft(json: unknown): BillDraft {
  return draftJson.parse(json);
}

export type DiscountChoice = { type: DiscountType; value: number; applyServiceCharge: boolean };

export async function fetchBillDraft(
  client: SupabaseClient<Database>,
  sessionId: string,
  discount: DiscountChoice,
): Promise<BillDraft> {
  const { data, error } = await client.rpc('admin_preview_bill', {
    p_session_id: sessionId,
    p_discount_type: discount.type,
    p_discount_value: discount.value,
    p_apply_service_charge: discount.applyServiceCharge,
  });
  if (error) throw error;
  return parseBillDraft(data);
}

// ─── Stored bill ──────────────────────────────────────────────────────────────

export type RestaurantSnapshot = {
  name: string;
  legalName: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  gstin: string | null;
  fssaiLicense: string | null;
  logoPath: string | null;
  footer: string | null;
};

const restaurantJson = z
  .object({
    name: z.string(),
    legal_name: z.string().nullish(),
    address_line: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    pincode: z.string().nullish(),
    phone: z.string().nullish(),
    gstin: z.string().nullish(),
    fssai_license: z.string().nullish(),
    logo_path: z.string().nullish(),
    footer: z.string().nullish(),
  })
  .transform((r): RestaurantSnapshot => ({
    name: r.name,
    legalName: r.legal_name ?? null,
    addressLine: r.address_line ?? null,
    city: r.city ?? null,
    state: r.state ?? null,
    pincode: r.pincode ?? null,
    phone: r.phone ?? null,
    gstin: r.gstin ?? null,
    fssaiLicense: r.fssai_license ?? null,
    logoPath: r.logo_path ?? null,
    footer: r.footer ?? null,
  }));

export type BillDocument = BillTotals & {
  id: string | null;
  isSample: boolean;
  invoiceNumber: string;
  documentType: DocumentType;
  status: BillStatus;
  paymentStatus: PaymentStatus;
  tableLabel: string;
  waiterName: string | null;
  generatedAt: string;
  generatedByName: string | null;
  lines: BillLine[];
  restaurant: RestaurantSnapshot;
  gstMode: GstMode;
  gstRateBps: number;
  pricesIncludeTax: boolean;
  discountType: DiscountType;
  discountValue: number;
  discountReason: string | null;
  serviceChargeBps: number;
  printCount: number;
  paidAt: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
};

const documentJson = z
  .object({
    id: z.string().nullable(),
    is_sample: z.boolean(),
    invoice_number: z.string(),
    document_type: z.enum(Constants.public.Enums.document_type),
    status: z.enum(Constants.public.Enums.bill_status),
    payment_status: z.enum(Constants.public.Enums.payment_status),
    table_label: z.string(),
    waiter_name: z.string().nullable(),
    generated_at: z.string(),
    generated_by_name: z.string().nullable(),
    lines: z.array(lineJson),
    restaurant: restaurantJson,
    gst_mode: z.enum(Constants.public.Enums.gst_mode),
    gst_rate_bps: z.number().int(),
    prices_include_tax: z.boolean(),
    discount_type: z.enum(Constants.public.Enums.discount_type),
    discount_value: z.number().int(),
    discount_reason: z.string().nullable(),
    service_charge_bps: z.number().int(),
    print_count: z.number().int(),
    paid_at: z.string().nullable(),
    void_reason: z.string().nullable(),
    voided_at: z.string().nullable(),
    voided_by_name: z.string().nullable(),
    ...totalsShape,
  })
  .transform((b): BillDocument => ({
    ...totalsFrom(b),
    id: b.id,
    isSample: b.is_sample,
    invoiceNumber: b.invoice_number,
    documentType: b.document_type,
    status: b.status,
    paymentStatus: b.payment_status,
    tableLabel: b.table_label,
    waiterName: b.waiter_name,
    generatedAt: b.generated_at,
    generatedByName: b.generated_by_name,
    lines: b.lines,
    restaurant: b.restaurant,
    gstMode: b.gst_mode,
    gstRateBps: b.gst_rate_bps,
    pricesIncludeTax: b.prices_include_tax,
    discountType: b.discount_type,
    discountValue: b.discount_value,
    discountReason: b.discount_reason,
    serviceChargeBps: b.service_charge_bps,
    printCount: b.print_count,
    paidAt: b.paid_at,
    voidReason: b.void_reason,
    voidedAt: b.voided_at,
    voidedByName: b.voided_by_name,
  }));

export type PrintSettings = {
  paperWidth: PaperWidth;
  timezone: string;
  printWaiterOnBill: boolean;
  showBranding: boolean;
  upi: { vpa: string; payeeName: string } | null;
};

const printJson = z
  .object({
    paper_width: z.enum(Constants.public.Enums.paper_width),
    timezone: z.string(),
    print_waiter_on_bill: z.boolean(),
    show_branding: z.boolean(),
    upi: z.object({ vpa: z.string(), payee_name: z.string() }).nullable(),
  })
  .transform((p): PrintSettings => ({
    paperWidth: p.paper_width,
    timezone: p.timezone,
    printWaiterOnBill: p.print_waiter_on_bill,
    showBranding: p.show_branding,
    upi: p.upi && { vpa: p.upi.vpa, payeeName: p.upi.payee_name },
  }));

export type PrintableBill = { bill: BillDocument; print: PrintSettings };

export function parseSampleBill(json: unknown): PrintableBill {
  return z.object({ bill: documentJson, print: printJson }).parse(json);
}

export type BillPayment = {
  id: string;
  mode: PaymentMode;
  amountPaise: number;
  reference: string | null;
  isVoid: boolean;
  createdAt: string;
  recordedByName: string | null;
};

export type AuditEntry = {
  id: string;
  action: string;
  actorLabel: string;
  reason: string | null;
  after: Record<string, unknown> | null;
  createdAt: string;
};

export type ReopenBlocker = 'void' | 'window' | 'table_busy' | 'table_inactive';

export type BillDetail = PrintableBill & {
  now: string;
  session: { id: string; status: Enums['session_status']; openedAt: string };
  payments: BillPayment[];
  audit: AuditEntry[];
  reopen: { allowed: boolean; blocker: ReopenBlocker | null; until: string | null };
  splitPayments: boolean;
};

const detailJson = z
  .object({
    now: z.string(),
    bill: documentJson,
    print: printJson,
    session: z.object({
      id: z.string(),
      status: z.enum(Constants.public.Enums.session_status),
      opened_at: z.string(),
    }),
    payments: z.array(
      z.object({
        id: z.string(),
        mode: z.enum(Constants.public.Enums.payment_mode),
        amount_paise: paise,
        reference: z.string().nullable(),
        is_void: z.boolean(),
        created_at: z.string(),
        recorded_by_name: z.string().nullable(),
      }),
    ),
    audit: z.array(
      z.object({
        id: z.string(),
        action: z.string(),
        actor_label: z.string(),
        reason: z.string().nullable(),
        after: z.record(z.string(), z.unknown()).nullable(),
        created_at: z.string(),
      }),
    ),
    reopen: z.object({
      allowed: z.boolean(),
      blocker: z.enum(['void', 'window', 'table_busy', 'table_inactive']).nullable(),
      until: z.string().nullable(),
    }),
    features: z.object({ split_payments: z.boolean() }),
  })
  .transform((d): BillDetail => ({
    now: d.now,
    bill: d.bill,
    print: d.print,
    session: { id: d.session.id, status: d.session.status, openedAt: d.session.opened_at },
    payments: d.payments.map((p) => ({
      id: p.id,
      mode: p.mode,
      amountPaise: p.amount_paise,
      reference: p.reference,
      isVoid: p.is_void,
      createdAt: p.created_at,
      recordedByName: p.recorded_by_name,
    })),
    audit: d.audit.map((a) => ({
      id: a.id,
      action: a.action,
      actorLabel: a.actor_label,
      reason: a.reason,
      after: a.after,
      createdAt: a.created_at,
    })),
    reopen: d.reopen,
    splitPayments: d.features.split_payments,
  }));

export function parseBillDetail(json: unknown): BillDetail {
  return detailJson.parse(json);
}

// ─── Open tables to bill ──────────────────────────────────────────────────────

export type BillingSession = {
  sessionId: string;
  tableLabel: string;
  openedAt: string;
  waiterName: string | null;
  items: number;
  subtotalPaise: number;
  unserved: number;
  waiting: number;
};

export type BillingSessions = { now: string; fetchedAt: number; sessions: BillingSession[] };

const billingSessionsJson = z.object({
  now: z.string(),
  sessions: z.array(
    z
      .object({
        session_id: z.string(),
        table_label: z.string(),
        opened_at: z.string(),
        waiter_name: z.string().nullable(),
        items: z.number().int(),
        subtotal_paise: paise,
        unserved: z.number().int(),
        waiting: z.number().int(),
      })
      .transform((s): BillingSession => ({
        sessionId: s.session_id,
        tableLabel: s.table_label,
        openedAt: s.opened_at,
        waiterName: s.waiter_name,
        items: s.items,
        subtotalPaise: s.subtotal_paise,
        unserved: s.unserved,
        waiting: s.waiting,
      })),
  ),
});

export function parseBillingSessions(json: unknown, fetchedAt = Date.now()): BillingSessions {
  return { ...billingSessionsJson.parse(json), fetchedAt };
}

export async function fetchBillingSessions(
  client: SupabaseClient<Database>,
): Promise<BillingSessions> {
  const { data, error } = await client.rpc('admin_billing_sessions');
  if (error) throw error;
  return parseBillingSessions(data);
}

// ─── Total orders ─────────────────────────────────────────────────────────────

export type TotalOrdersBill = {
  id: string;
  invoiceNumber: string;
  status: BillStatus;
  paymentStatus: PaymentStatus;
  tableLabel: string;
  waiterName: string | null;
  openedAt: string;
  generatedAt: string;
  minutes: number;
  items: number;
  grandTotalPaise: number;
  modes: PaymentMode[];
  generatedByName: string | null;
};

export type ClosedSession = {
  sessionId: string;
  tableLabel: string;
  waiterName: string | null;
  openedAt: string;
  closedAt: string;
  closedByName: string | null;
  reason: string | null;
};

export type TotalOrdersSummary = {
  bills: number;
  orders: number;
  items: number;
  grossPaise: number;
  discountPaise: number;
  taxPaise: number;
  totalPaise: number;
  collectedPaise: number;
  unpaidBills: number;
  voidBills: number;
  closedUnbilled: number;
};

type TotalOrdersBase = {
  today: string;
  from: string;
  to: string;
  page: number;
  pageSize: number;
  total: number;
  summary: TotalOrdersSummary;
  tables: { id: string; label: string }[];
  waiters: { id: string; name: string; isActive: boolean }[];
};

export type TotalOrders =
  | (TotalOrdersBase & { view: 'bills'; rows: TotalOrdersBill[] })
  | (TotalOrdersBase & { view: 'closed_unbilled'; rows: ClosedSession[] });

const summaryJson = z.object({
  bills: z.number().int(),
  orders: z.number().int(),
  items: z.number().int(),
  gross_paise: paise,
  discount_paise: paise,
  tax_paise: paise,
  total_paise: paise,
  collected_paise: paise,
  unpaid_bills: z.number().int(),
  void_bills: z.number().int(),
  closed_unbilled: z.number().int(),
});

const billRowJson = z.object({
  id: z.string(),
  invoice_number: z.string(),
  status: z.enum(Constants.public.Enums.bill_status),
  payment_status: z.enum(Constants.public.Enums.payment_status),
  table_label: z.string(),
  waiter_name: z.string().nullable(),
  opened_at: z.string(),
  generated_at: z.string(),
  minutes: z.number().int(),
  items: z.number().int(),
  grand_total_paise: paise,
  modes: z.array(z.enum(Constants.public.Enums.payment_mode)),
  generated_by_name: z.string().nullable(),
});

const closedRowJson = z.object({
  session_id: z.string(),
  table_label: z.string(),
  waiter_name: z.string().nullable(),
  opened_at: z.string(),
  closed_at: z.string(),
  closed_by_name: z.string().nullable(),
  reason: z.string().nullable(),
});

const totalOrdersJson = z.object({
  today: z.string(),
  from: z.string(),
  to: z.string(),
  view: z.enum(['bills', 'closed_unbilled']),
  page: z.number().int(),
  page_size: z.number().int(),
  total: z.number().int(),
  summary: summaryJson,
  rows: z.array(z.unknown()),
  tables: z.array(z.object({ id: z.string(), label: z.string() })),
  waiters: z.array(z.object({ id: z.string(), name: z.string(), is_active: z.boolean() })),
});

export function parseTotalOrders(json: unknown): TotalOrders {
  const t = totalOrdersJson.parse(json);
  const s = t.summary;
  const base: TotalOrdersBase = {
    today: t.today,
    from: t.from,
    to: t.to,
    page: t.page,
    pageSize: t.page_size,
    total: t.total,
    summary: {
      bills: s.bills,
      orders: s.orders,
      items: s.items,
      grossPaise: s.gross_paise,
      discountPaise: s.discount_paise,
      taxPaise: s.tax_paise,
      totalPaise: s.total_paise,
      collectedPaise: s.collected_paise,
      unpaidBills: s.unpaid_bills,
      voidBills: s.void_bills,
      closedUnbilled: s.closed_unbilled,
    },
    tables: t.tables,
    waiters: t.waiters.map((w) => ({ id: w.id, name: w.name, isActive: w.is_active })),
  };
  if (t.view === 'closed_unbilled') {
    return {
      ...base,
      view: 'closed_unbilled',
      rows: z
        .array(closedRowJson)
        .parse(t.rows)
        .map((r) => ({
          sessionId: r.session_id,
          tableLabel: r.table_label,
          waiterName: r.waiter_name,
          openedAt: r.opened_at,
          closedAt: r.closed_at,
          closedByName: r.closed_by_name,
          reason: r.reason,
        })),
    };
  }
  return {
    ...base,
    view: 'bills',
    rows: z
      .array(billRowJson)
      .parse(t.rows)
      .map((r) => ({
        id: r.id,
        invoiceNumber: r.invoice_number,
        status: r.status,
        paymentStatus: r.payment_status,
        tableLabel: r.table_label,
        waiterName: r.waiter_name,
        openedAt: r.opened_at,
        generatedAt: r.generated_at,
        minutes: r.minutes,
        items: r.items,
        grandTotalPaise: r.grand_total_paise,
        modes: r.modes,
        generatedByName: r.generated_by_name,
      })),
  };
}

// ─── Labels ───────────────────────────────────────────────────────────────────

export const DOCUMENT_TITLES: Record<DocumentType, string> = {
  tax_invoice: 'Tax Invoice',
  bill_of_supply: 'Bill of Supply',
  bill: 'Bill',
};

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  other: 'Other',
};

/** Basis points as a percentage: 250 → "2.5%", 500 → "5%". */
export function percentLabel(bps: number): string {
  return `${(bps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;
}

/** Half the GST rate for each of CGST and SGST: 500 → "2.5%". */
export function halfRateLabel(bps: number): string {
  return percentLabel(bps / 2);
}

/** "Butter Chicken (Half)". */
export function lineName(line: Pick<BillLine, 'name' | 'variant'>): string {
  return line.variant ? `${line.name} (${line.variant})` : line.name;
}
