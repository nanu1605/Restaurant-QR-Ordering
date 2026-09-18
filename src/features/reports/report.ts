import { z } from 'zod';

import { Constants } from '@/types/database';

/**
 * Reports (spec §13.3, §19 Phase 6): what the report functions return and the
 * labels the screens use. Money is paise; dates are business dates in the
 * restaurant's timezone (docs/DECISIONS.md P6-1…P6-8).
 */

const paise = z.number().int();

// ─── Sales ────────────────────────────────────────────────────────────────────

export type Collected = { cash: number; upi: number; card: number; other: number };

export type SalesTotals = {
  bills: number;
  grossPaise: number;
  discountPaise: number;
  serviceChargePaise: number;
  taxPaise: number;
  roundOffPaise: number;
  netPaise: number;
  totalPaise: number;
  averagePaise: number;
  unpaidBills: number;
  unpaidPaise: number;
  /** Null for a Starter restaurant: payment modes need the plan feature. */
  collected: Collected | null;
};

export type SalesDay = SalesTotals & { date: string };

export type SalesHour = { weekday: number; hour: number; bills: number; totalPaise: number };

export type SalesReport = {
  today: string;
  from: string;
  to: string;
  startHour: number;
  /** True when the restaurant only gets the summary (Starter). */
  basic: boolean;
  summary: SalesTotals;
  days: SalesDay[] | null;
  hours: SalesHour[] | null;
};

const collectedJson = z.object({
  cash: paise,
  upi: paise,
  card: paise,
  other: paise,
});

const totalsJson = z.object({
  bills: z.number().int(),
  gross_paise: paise,
  discount_paise: paise,
  service_charge_paise: paise,
  tax_paise: paise,
  round_off_paise: paise,
  net_paise: paise,
  total_paise: paise,
  average_paise: paise,
  unpaid_bills: z.number().int(),
  unpaid_paise: paise,
  collected: collectedJson.nullable(),
});

function toTotals(t: z.infer<typeof totalsJson>): SalesTotals {
  return {
    bills: t.bills,
    grossPaise: t.gross_paise,
    discountPaise: t.discount_paise,
    serviceChargePaise: t.service_charge_paise,
    taxPaise: t.tax_paise,
    roundOffPaise: t.round_off_paise,
    netPaise: t.net_paise,
    totalPaise: t.total_paise,
    averagePaise: t.average_paise,
    unpaidBills: t.unpaid_bills,
    unpaidPaise: t.unpaid_paise,
    collected: t.collected,
  };
}

const salesJson = z.object({
  today: z.string(),
  from: z.string(),
  to: z.string(),
  start_hour: z.number().int(),
  basic: z.boolean(),
  summary: totalsJson,
  days: z.array(totalsJson.extend({ date: z.string() })).nullable(),
  hours: z
    .array(
      z.object({
        weekday: z.number().int(),
        hour: z.number().int(),
        bills: z.number().int(),
        total_paise: paise,
      }),
    )
    .nullable(),
});

export function parseSalesReport(json: unknown): SalesReport {
  const r = salesJson.parse(json);
  return {
    today: r.today,
    from: r.from,
    to: r.to,
    startHour: r.start_hour,
    basic: r.basic,
    summary: toTotals(r.summary),
    days: r.days?.map((d) => ({ ...toTotals(d), date: d.date })) ?? null,
    hours:
      r.hours?.map((h) => ({
        weekday: h.weekday,
        hour: h.hour,
        bills: h.bills,
        totalPaise: h.total_paise,
      })) ?? null,
  };
}

// ─── Items and categories ─────────────────────────────────────────────────────

export type ItemSales = {
  menuItemId: string | null;
  variantId: string | null;
  name: string;
  variant: string | null;
  foodType: (typeof Constants.public.Enums.food_type)[number] | null;
  category: string | null;
  qty: number;
  revenuePaise: number;
};

export type CategorySales = {
  categoryId: string | null;
  name: string | null;
  qty: number;
  revenuePaise: number;
  dishes: number;
};

export type ItemsReport = {
  today: string;
  from: string;
  to: string;
  items: ItemSales[];
  categories: CategorySales[];
};

const itemsJson = z.object({
  today: z.string(),
  from: z.string(),
  to: z.string(),
  items: z.array(
    z.object({
      menu_item_id: z.string().nullable(),
      variant_id: z.string().nullable(),
      name: z.string(),
      variant: z.string().nullable(),
      food_type: z.enum(Constants.public.Enums.food_type).nullable(),
      category: z.string().nullable(),
      qty: z.number().int(),
      revenue_paise: paise,
    }),
  ),
  categories: z.array(
    z.object({
      category_id: z.string().nullable(),
      name: z.string().nullable(),
      qty: z.number().int(),
      revenue_paise: paise,
      dishes: z.number().int(),
    }),
  ),
});

export function parseItemsReport(json: unknown): ItemsReport {
  const r = itemsJson.parse(json);
  return {
    today: r.today,
    from: r.from,
    to: r.to,
    items: r.items.map((i) => ({
      menuItemId: i.menu_item_id,
      variantId: i.variant_id,
      name: i.name,
      variant: i.variant,
      foodType: i.food_type,
      category: i.category,
      qty: i.qty,
      revenuePaise: i.revenue_paise,
    })),
    categories: r.categories.map((c) => ({
      categoryId: c.category_id,
      name: c.name,
      qty: c.qty,
      revenuePaise: c.revenue_paise,
      dishes: c.dishes,
    })),
  };
}

// ─── Tables ───────────────────────────────────────────────────────────────────

export type TableTurnover = {
  tableId: string;
  label: string;
  isActive: boolean;
  sessions: number;
  minutes: number;
  totalPaise: number;
  averagePaise: number;
};

export type TablesReport = {
  today: string;
  from: string;
  to: string;
  overall: {
    sessions: number;
    minutes: number;
    totalPaise: number;
    tables: number;
    perTable: number;
  };
  tables: TableTurnover[];
};

const tablesJson = z.object({
  today: z.string(),
  from: z.string(),
  to: z.string(),
  overall: z.object({
    sessions: z.number().int(),
    minutes: z.number().int(),
    total_paise: paise,
    tables: z.number().int(),
    per_table: z.number(),
  }),
  tables: z.array(
    z.object({
      table_id: z.string(),
      label: z.string(),
      is_active: z.boolean(),
      sessions: z.number().int(),
      minutes: z.number().int(),
      total_paise: paise,
      average_paise: paise,
    }),
  ),
});

export function parseTablesReport(json: unknown): TablesReport {
  const r = tablesJson.parse(json);
  return {
    today: r.today,
    from: r.from,
    to: r.to,
    overall: {
      sessions: r.overall.sessions,
      minutes: r.overall.minutes,
      totalPaise: r.overall.total_paise,
      tables: r.overall.tables,
      perTable: r.overall.per_table,
    },
    tables: r.tables.map((t) => ({
      tableId: t.table_id,
      label: t.label,
      isActive: t.is_active,
      sessions: t.sessions,
      minutes: t.minutes,
      totalPaise: t.total_paise,
      averagePaise: t.average_paise,
    })),
  };
}

// ─── Waiters ──────────────────────────────────────────────────────────────────

export type WaiterRow = {
  waiterId: string;
  name: string;
  isActive: boolean;
  onDuty: boolean;
  tables: number;
  salesPaise: number;
  minutes: number;
  rounds: number;
  items: number;
  openTables: number;
};

export type WaiterDay = { date: string; waiterId: string; tables: number };

export type WaiterReport = {
  today: string;
  from: string;
  to: string;
  waiters: WaiterRow[];
  days: WaiterDay[];
};

const waitersJson = z.object({
  today: z.string(),
  from: z.string(),
  to: z.string(),
  waiters: z.array(
    z.object({
      waiter_id: z.string(),
      name: z.string(),
      is_active: z.boolean(),
      on_duty: z.boolean(),
      tables: z.number().int(),
      sales_paise: paise,
      minutes: z.number().int(),
      rounds: z.number().int(),
      items: z.number().int(),
      open_tables: z.number().int(),
    }),
  ),
  days: z.array(z.object({ date: z.string(), waiter_id: z.string(), tables: z.number().int() })),
});

export function parseWaiterReport(json: unknown): WaiterReport {
  const r = waitersJson.parse(json);
  return {
    today: r.today,
    from: r.from,
    to: r.to,
    waiters: r.waiters.map((w) => ({
      waiterId: w.waiter_id,
      name: w.name,
      isActive: w.is_active,
      onDuty: w.on_duty,
      tables: w.tables,
      salesPaise: w.sales_paise,
      minutes: w.minutes,
      rounds: w.rounds,
      items: w.items,
      openTables: w.open_tables,
    })),
    days: r.days.map((d) => ({ date: d.date, waiterId: d.waiter_id, tables: d.tables })),
  };
}

// ─── Activity logs ────────────────────────────────────────────────────────────

export const ACTIVITY_KINDS = ['voids_discounts', 'removed_items', 'deleted_orders'] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  voids_discounts: 'Voids & discounts',
  removed_items: 'Removed dishes',
  deleted_orders: 'Deleted orders',
};

type ActivityBase = {
  at: string;
  actorName: string | null;
  actorRole: string | null;
  reason: string | null;
};

export type VoidOrDiscountRow = ActivityBase & {
  kind: 'void' | 'discount';
  billId: string;
  invoiceNumber: string;
  tableLabel: string;
  billStatus: 'active' | 'void';
  totalPaise: number;
  amountPaise: number;
  discountType: string | null;
  discountValue: number | null;
  reopened: boolean | null;
};

export type RemovedItemRow = ActivityBase & {
  name: string | null;
  variant: string | null;
  quantity: number;
  wasServed: boolean;
  valuePaise: number;
  tableLabel: string | null;
  roundNumber: number | null;
};

export type DeletedOrderRow = ActivityBase & {
  roundNumber: number | null;
  tableLabel: string | null;
  items: { name: string | null; variant: string | null; quantity: number }[];
  quantity: number;
  valuePaise: number;
};

type ActivityBaseReport = {
  today: string;
  from: string;
  to: string;
  page: number;
  pageSize: number;
  total: number;
};

export type ActivityReport =
  | (ActivityBaseReport & { kind: 'voids_discounts'; rows: VoidOrDiscountRow[] })
  | (ActivityBaseReport & { kind: 'removed_items'; rows: RemovedItemRow[] })
  | (ActivityBaseReport & { kind: 'deleted_orders'; rows: DeletedOrderRow[] });

const activityBaseJson = z.object({
  at: z.string(),
  actor_name: z.string().nullable(),
  actor_role: z.string().nullable(),
  reason: z.string().nullable(),
});

const voidRowJson = activityBaseJson.extend({
  kind: z.enum(['void', 'discount']),
  bill_id: z.string(),
  invoice_number: z.string(),
  table_label: z.string(),
  bill_status: z.enum(Constants.public.Enums.bill_status),
  total_paise: paise,
  amount_paise: paise,
  discount_type: z.string().nullable(),
  discount_value: z.number().int().nullable(),
  reopened: z.boolean().nullable(),
});

const removedRowJson = activityBaseJson.extend({
  name: z.string().nullable(),
  variant: z.string().nullable(),
  quantity: z.number().int(),
  was_served: z.boolean(),
  value_paise: paise,
  table_label: z.string().nullable(),
  round_number: z.number().int().nullable(),
});

const deletedRowJson = activityBaseJson.extend({
  round_number: z.number().int().nullable(),
  table_label: z.string().nullable(),
  items: z.array(
    z.object({
      name: z.string().nullable().default(null),
      variant: z.string().nullable().default(null),
      quantity: z.number().int().default(0),
    }),
  ),
  quantity: z.number().int(),
  value_paise: paise,
});

const activityJson = z.object({
  today: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(ACTIVITY_KINDS),
  page: z.number().int(),
  page_size: z.number().int(),
  total: z.number().int(),
  rows: z.array(z.unknown()),
});

function toBase(r: z.infer<typeof activityBaseJson>): ActivityBase {
  return { at: r.at, actorName: r.actor_name, actorRole: r.actor_role, reason: r.reason };
}

export function parseActivityReport(json: unknown): ActivityReport {
  const r = activityJson.parse(json);
  const base: ActivityBaseReport = {
    today: r.today,
    from: r.from,
    to: r.to,
    page: r.page,
    pageSize: r.page_size,
    total: r.total,
  };
  if (r.kind === 'voids_discounts') {
    return {
      ...base,
      kind: 'voids_discounts',
      rows: z
        .array(voidRowJson)
        .parse(r.rows)
        .map((row) => ({
          ...toBase(row),
          kind: row.kind,
          billId: row.bill_id,
          invoiceNumber: row.invoice_number,
          tableLabel: row.table_label,
          billStatus: row.bill_status,
          totalPaise: row.total_paise,
          amountPaise: row.amount_paise,
          discountType: row.discount_type,
          discountValue: row.discount_value,
          reopened: row.reopened,
        })),
    };
  }
  if (r.kind === 'removed_items') {
    return {
      ...base,
      kind: 'removed_items',
      rows: z
        .array(removedRowJson)
        .parse(r.rows)
        .map((row) => ({
          ...toBase(row),
          name: row.name,
          variant: row.variant,
          quantity: row.quantity,
          wasServed: row.was_served,
          valuePaise: row.value_paise,
          tableLabel: row.table_label,
          roundNumber: row.round_number,
        })),
    };
  }
  return {
    ...base,
    kind: 'deleted_orders',
    rows: z
      .array(deletedRowJson)
      .parse(r.rows)
      .map((row) => ({
        ...toBase(row),
        roundNumber: row.round_number,
        tableLabel: row.table_label,
        items: row.items,
        quantity: row.quantity,
        valuePaise: row.value_paise,
      })),
  };
}

// ─── Labels and formats ───────────────────────────────────────────────────────

/** Monday first, matching the heatmap's ISO weekdays (1 = Monday). */
export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

export const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The 24 hours of a business day, starting at the restaurant's start hour. */
export function hourOrder(startHour: number): number[] {
  return Array.from({ length: 24 }, (_, i) => (startHour + i) % 24);
}

/** "5 pm", "12 am" — the label for a heatmap column. */
export function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'am' : 'pm';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

/** "2 h 15 m" or "45 m", for table and waiter times. */
export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} m`;
}

/** Short rupees for chart axes: ₹950, ₹1.2L (Indian numbering). */
export function compactINR(paiseValue: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Math.round(paiseValue / 100));
}

/** "Butter Chicken · Half" for a dish row. */
export function dishLabel(name: string, variant: string | null): string {
  return variant ? `${name} · ${variant}` : name;
}
