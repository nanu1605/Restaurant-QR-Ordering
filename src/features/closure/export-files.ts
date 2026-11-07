import { csvDateTime, paiseToRupees, toCsv, type CsvCell } from '@/features/reports/csv';
import { APP_NAME } from '@/lib/config';
import type { Database } from '@/types/database';

/**
 * What a restaurant's data export holds (docs/DECISIONS.md SA-93). Each table
 * names its columns, so a new column stays out until someone decides it
 * belongs: no logins or user ids, no QR tokens, no device ids.
 */

type Tables = Database['public']['Tables'];

export const COLUMNS = {
  restaurants: [
    'name',
    'slug',
    'legal_name',
    'address_line',
    'city',
    'state',
    'pincode',
    'phone',
    'email',
    'logo_path',
    'gstin',
    'fssai_license',
    'gst_mode',
    'gst_rate_bps',
    'prices_include_tax',
    'service_charge_enabled',
    'service_charge_bps',
    'invoice_prefix',
    'bill_footer_text',
    'paper_width',
    'show_upi_qr_on_bill',
    'upi_vpa',
    'upi_payee_name',
    'require_first_order_approval',
    'customer_cancel_window_seconds',
    'max_tables_per_waiter',
    'staff_can_remove_served_items',
    'print_waiter_on_bill',
    'reopen_window_minutes',
    'business_day_start_hour',
    'timezone',
    'status',
    'created_at',
  ],
  restaurant_subscriptions: [
    'id',
    'status',
    'billing_cycle',
    'trial_ends_at',
    'current_period_start',
    'current_period_end',
    'cancel_at_period_end',
  ],
  menu_categories: ['id', 'name', 'name_hi', 'sort_order', 'is_active'],
  menu_items: [
    'id',
    'category_id',
    'name',
    'name_hi',
    'description',
    'price_paise',
    'food_type',
    'image_path',
    'is_available',
    'is_active',
    'sort_order',
  ],
  menu_item_variants: ['id', 'menu_item_id', 'name', 'price_paise', 'sort_order', 'is_active'],
  menu_addon_groups: ['id', 'name', 'min_select', 'max_select'],
  menu_addons: ['id', 'group_id', 'name', 'price_paise', 'is_available', 'sort_order'],
  dining_tables: ['id', 'label', 'sort_order', 'is_active', 'created_at'],
  restaurant_members: ['id', 'display_name', 'username', 'role', 'is_active', 'created_at'],
  waiters: [
    'id',
    'full_name',
    'phone',
    'employee_code',
    'joined_on',
    'notes',
    'on_duty',
    'is_active',
    'deleted_at',
  ],
  table_sessions: ['id', 'table_label_snapshot'],
  orders: [
    'id',
    'session_id',
    'round_number',
    'status',
    'placed_via',
    'customer_note',
    'reject_reason',
    'removed_reason',
    'created_at',
  ],
  order_items: [
    'id',
    'order_id',
    'item_name_snapshot',
    'variant_name_snapshot',
    'food_type_snapshot',
    'unit_price_paise',
    'quantity',
    'addons_snapshot',
    'note',
    'status',
    'served_at',
    'cancelled_at',
    'removed_at',
    'removed_reason',
  ],
  bills: [
    'id',
    'invoice_number',
    'financial_year',
    'document_type',
    'table_label_snapshot',
    'waiter_name_snapshot',
    'line_items',
    'restaurant_snapshot',
    'gst_mode',
    'gst_rate_bps',
    'prices_include_tax',
    'subtotal_paise',
    'discount_type',
    'discount_value',
    'discount_paise',
    'discount_reason',
    'service_charge_bps',
    'service_charge_paise',
    'taxable_paise',
    'cgst_paise',
    'sgst_paise',
    'total_tax_paise',
    'round_off_paise',
    'grand_total_paise',
    'payment_status',
    'status',
    'generated_at',
    'paid_at',
    'void_reason',
    'voided_at',
  ],
  bill_payments: ['id', 'bill_id', 'mode', 'amount_paise', 'reference', 'is_void', 'created_at'],
  subscription_payments: [
    'id',
    'purpose',
    'source',
    'manual_mode',
    'amount_paise',
    'base_paise',
    'gst_paise',
    'period_start',
    'period_end',
    'razorpay_payment_id',
    'created_at',
  ],
} as const satisfies { [T in keyof Tables]?: readonly (keyof Tables[T]['Row'])[] };

type Columns = typeof COLUMNS;
type RowOf<T extends keyof Columns> = Pick<
  Tables[T]['Row'],
  Columns[T][number] & keyof Tables[T]['Row']
>;

export type ExportData = {
  restaurant: RowOf<'restaurants'>;
  subscription: (RowOf<'restaurant_subscriptions'> & { plans: { name: string } | null }) | null;
  categories: RowOf<'menu_categories'>[];
  items: RowOf<'menu_items'>[];
  variants: RowOf<'menu_item_variants'>[];
  addonGroups: (RowOf<'menu_addon_groups'> & {
    menu_item_addon_groups: { menu_item_id: string }[];
  })[];
  addons: RowOf<'menu_addons'>[];
  tables: RowOf<'dining_tables'>[];
  staff: RowOf<'restaurant_members'>[];
  waiters: RowOf<'waiters'>[];
  sessions: RowOf<'table_sessions'>[];
  orders: RowOf<'orders'>[];
  orderItems: RowOf<'order_items'>[];
  bills: RowOf<'bills'>[];
  billPayments: RowOf<'bill_payments'>[];
  subscriptionPayments: RowOf<'subscription_payments'>[];
};

const rupees = (paise: number | null): CsvCell => (paise === null ? null : paiseToRupees(paise));
const yesNo = (value: boolean) => (value ? 'Yes' : 'No');
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The files, one at a time, so each can be compressed and let go of. */
export function* exportFiles(data: ExportData, builtAt: Date) {
  const { restaurant } = data;
  const { timezone } = restaurant;
  const when = (iso: string | null) => (iso ? csvDateTime(iso, timezone) : null);
  const csv = (name: string, headers: string[], rows: CsvCell[][]) => ({
    name,
    text: toCsv({ headers, rows }),
  });

  yield {
    name: 'README.txt',
    text: [
      `${restaurant.name}: a copy of its ${APP_NAME} data, made ${csvDateTime(builtAt.toISOString(), timezone)} (${timezone}).`,
      '',
      'profile.json          The restaurant, its settings and its subscription',
      'menu.json             Categories, dishes, variants and add-ons',
      'tables.csv            Tables',
      'staff.csv             Staff logins (never passwords)',
      'waiters.csv           Waiters',
      'orders.csv            Orders',
      'order_items.csv       The dishes on each order',
      'bills.csv             Bills and invoices',
      'bills.json            The same, each with its lines and the details printed on it',
      'bill_payments.csv     Payments recorded against bills',
      `subscription_payments.csv  What was paid to ${APP_NAME}`,
      '',
      `Amounts in CSV files are in rupees; in JSON files they are in paise. Times in CSV files are in ${timezone}; in JSON files they are in UTC.`,
      '',
    ].join('\r\n'),
  };
  yield {
    name: 'profile.json',
    text: json({ ...restaurant, subscription: data.subscription }),
  };
  yield {
    name: 'menu.json',
    text: json({
      categories: data.categories,
      dishes: data.items,
      variants: data.variants,
      addon_groups: data.addonGroups.map(({ menu_item_addon_groups: links, ...group }) => ({
        ...group,
        dish_ids: links.map((link) => link.menu_item_id),
      })),
      addons: data.addons,
    }),
  };
  yield csv(
    'tables.csv',
    ['Table', 'Order', 'In use', 'Added'],
    data.tables.map((t) => [t.label, t.sort_order, yesNo(t.is_active), when(t.created_at)]),
  );
  yield csv(
    'staff.csv',
    ['Name', 'Username', 'Role', 'Active', 'Added'],
    data.staff.map((m) => [
      m.display_name,
      m.username,
      m.role,
      yesNo(m.is_active),
      when(m.created_at),
    ]),
  );
  yield csv(
    'waiters.csv',
    ['Name', 'Phone', 'Employee code', 'Joined', 'On duty', 'Working here', 'Removed', 'Notes'],
    data.waiters.map((w) => [
      w.full_name,
      w.phone,
      w.employee_code,
      w.joined_on,
      yesNo(w.on_duty),
      yesNo(w.is_active),
      when(w.deleted_at),
      w.notes,
    ]),
  );
  const tableOf = new Map(data.sessions.map((s) => [s.id, s.table_label_snapshot]));
  yield csv(
    'orders.csv',
    [
      'Order ID',
      'Table',
      'Round',
      'Status',
      'Placed by',
      'Note',
      'Rejected because',
      'Removed because',
      'Placed at',
    ],
    data.orders.map((o) => [
      o.id,
      tableOf.get(o.session_id),
      o.round_number,
      o.status,
      o.placed_via,
      o.customer_note,
      o.reject_reason,
      o.removed_reason,
      when(o.created_at),
    ]),
  );
  yield csv(
    'order_items.csv',
    [
      'Order ID',
      'Dish',
      'Variant',
      'Food type',
      'Unit price',
      'Quantity',
      'Add-ons',
      'Note',
      'Status',
      'Served at',
      'Cancelled at',
      'Removed at',
      'Removed because',
    ],
    data.orderItems.map((i) => [
      i.order_id,
      i.item_name_snapshot,
      i.variant_name_snapshot,
      i.food_type_snapshot,
      rupees(i.unit_price_paise),
      i.quantity,
      JSON.stringify(i.addons_snapshot),
      i.note,
      i.status,
      when(i.served_at),
      when(i.cancelled_at),
      when(i.removed_at),
      i.removed_reason,
    ]),
  );
  yield csv(
    'bills.csv',
    [
      'Invoice',
      'Type',
      'Financial year',
      'Table',
      'Waiter',
      'Subtotal',
      'Discount',
      'Discount reason',
      'Service charge',
      'Taxable',
      'CGST',
      'SGST',
      'Total tax',
      'Round off',
      'Total',
      'Payment',
      'Status',
      'Generated at',
      'Paid at',
      'Voided at',
      'Void reason',
    ],
    data.bills.map((b) => [
      b.invoice_number,
      b.document_type,
      b.financial_year,
      b.table_label_snapshot,
      b.waiter_name_snapshot,
      rupees(b.subtotal_paise),
      rupees(b.discount_paise),
      b.discount_reason,
      rupees(b.service_charge_paise),
      rupees(b.taxable_paise),
      rupees(b.cgst_paise),
      rupees(b.sgst_paise),
      rupees(b.total_tax_paise),
      rupees(b.round_off_paise),
      rupees(b.grand_total_paise),
      b.payment_status,
      b.status,
      when(b.generated_at),
      when(b.paid_at),
      when(b.voided_at),
      b.void_reason,
    ]),
  );
  yield { name: 'bills.json', text: json(data.bills) };
  const invoiceOf = new Map(data.bills.map((b) => [b.id, b.invoice_number]));
  yield csv(
    'bill_payments.csv',
    ['Invoice', 'Mode', 'Amount', 'Reference', 'Voided', 'Recorded at'],
    data.billPayments.map((p) => [
      invoiceOf.get(p.bill_id),
      p.mode,
      rupees(p.amount_paise),
      p.reference,
      yesNo(p.is_void),
      when(p.created_at),
    ]),
  );
  yield csv(
    'subscription_payments.csv',
    [
      'Date',
      'For',
      'Paid by',
      'Mode',
      'Amount',
      'Before GST',
      'GST',
      'Period start',
      'Period end',
      'Razorpay payment',
    ],
    data.subscriptionPayments.map((p) => [
      when(p.created_at),
      p.purpose,
      p.source,
      p.manual_mode,
      rupees(p.amount_paise),
      rupees(p.base_paise),
      rupees(p.gst_paise),
      when(p.period_start),
      when(p.period_end),
      p.razorpay_payment_id,
    ]),
  );
}
