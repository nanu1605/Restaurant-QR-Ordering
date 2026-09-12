import { z } from 'zod';

import { UPI_VPA_PATTERN } from '@/lib/upi';
import { Constants } from '@/types/database';

/**
 * Settings tabs (spec §13.3 Settings). Each tab saves on its own; the
 * database applies the same limits (column checks + admin_update_settings).
 */

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const GST_MODES = Constants.public.Enums.gst_mode;
export const PAPER_WIDTHS = Constants.public.Enums.paper_width;
/** GST slabs offered for restaurant bills. */
export const GST_RATES_BPS = [0, 500, 1200, 1800, 2800] as const;

/** "5" → 500, "2.5" → 250; null unless 0–100 with at most two decimals. */
export function percentToBps(text: string): number | null {
  const cleaned = text.trim().replace(/%$/, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return bps <= 10_000 ? bps : null;
}

/** 500 → "5", 250 → "2.5". */
export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = bps % 100;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}

const optionalText = (max: number) => z.string().trim().max(max, `Use ${max} characters or fewer.`);

// ─── Restaurant ─────────────────────────────────────────────────────────────
export const restaurantTabSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter the restaurant name.')
    .max(120, 'Use 120 characters or fewer.'),
  legalName: optionalText(160),
  addressLine: optionalText(300),
  city: optionalText(80),
  state: optionalText(80),
  pincode: z
    .string()
    .trim()
    .refine((value) => value === '' || /^[1-9][0-9]{5}$/.test(value), 'Enter a 6-digit pincode.'),
  phone: optionalText(20),
  email: z
    .string()
    .trim()
    .refine((value) => value === '' || z.email().safeParse(value).success, 'Enter a valid email.'),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a colour.'),
});
export type RestaurantTab = z.input<typeof restaurantTabSchema>;

// ─── Tax & charges ──────────────────────────────────────────────────────────
export const taxTabSchema = z
  .object({
    gstMode: z.enum(GST_MODES),
    gstRateBps: z.number().int().min(0).max(2800),
    pricesIncludeTax: z.boolean(),
    serviceChargeEnabled: z.boolean(),
    serviceChargePercent: z.string(),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .refine((value) => value === '' || GSTIN_PATTERN.test(value), {
        message: 'A GSTIN has 15 characters, e.g. 23AAACD1234E1Z5.',
      }),
    fssaiLicense: z
      .string()
      .trim()
      .refine((value) => value === '' || /^\d{14}$/.test(value), 'An FSSAI licence has 14 digits.'),
  })
  .superRefine((tax, ctx) => {
    if (tax.serviceChargeEnabled && percentToBps(tax.serviceChargePercent) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['serviceChargePercent'],
        message: 'Enter a percentage, e.g. 5 or 7.5.',
      });
    }
  });
export type TaxTab = z.input<typeof taxTabSchema>;

// ─── Bill ───────────────────────────────────────────────────────────────────
export const billTabSchema = z
  .object({
    invoicePrefix: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,10}$/, 'Use 1–10 letters, numbers or dashes.'),
    paperWidth: z.enum(PAPER_WIDTHS),
    billFooterText: optionalText(200),
    printWaiterOnBill: z.boolean(),
    showUpiQrOnBill: z.boolean(),
    upiVpa: z
      .string()
      .trim()
      .refine((value) => value === '' || UPI_VPA_PATTERN.test(value), {
        message: 'Enter a UPI ID like name@bank.',
      }),
    upiPayeeName: optionalText(80),
  })
  .superRefine((bill, ctx) => {
    if (bill.showUpiQrOnBill && bill.upiVpa === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['upiVpa'],
        message: 'Enter your UPI ID to show a UPI QR on bills.',
      });
    }
  });
export type BillTab = z.input<typeof billTabSchema>;

// ─── Ordering ───────────────────────────────────────────────────────────────
// Number inputs register with valueAsNumber, so an empty field arrives as NaN.
const wholeNumber = (min: number, max: number, message: string) =>
  z.number({ message }).int(message).min(min, message).max(max, message);

export const orderingTabSchema = z.object({
  requireFirstOrderApproval: z.boolean(),
  customerCancelWindowSeconds: wholeNumber(0, 600, 'Enter 0–600 seconds.'),
  reopenWindowMinutes: wholeNumber(0, 120, 'Enter 0–120 minutes.'),
  businessDayStartHour: wholeNumber(0, 23, 'Choose an hour.'),
  maxTablesPerWaiter: wholeNumber(1, 20, 'Enter 1–20 tables.'),
  staffCanRemoveServedItems: z.boolean(),
});
export type OrderingTab = z.input<typeof orderingTabSchema>;

/** Database patch for admin_update_settings from one tab's valid values. */
export function settingsPatch(
  tab: 'restaurant' | 'tax' | 'bill' | 'ordering',
  values:
    | z.output<typeof restaurantTabSchema>
    | z.output<typeof taxTabSchema>
    | z.output<typeof billTabSchema>
    | z.output<typeof orderingTabSchema>,
): Record<string, string | number | boolean | null> {
  const empty = (value: string) => (value === '' ? null : value);
  switch (tab) {
    case 'restaurant': {
      const v = values as z.output<typeof restaurantTabSchema>;
      return {
        name: v.name,
        legal_name: empty(v.legalName),
        address_line: empty(v.addressLine),
        city: empty(v.city),
        state: empty(v.state),
        pincode: empty(v.pincode),
        phone: empty(v.phone),
        email: empty(v.email),
        accent_color: v.accentColor.toLowerCase(),
      };
    }
    case 'tax': {
      const v = values as z.output<typeof taxTabSchema>;
      return {
        gst_mode: v.gstMode,
        gst_rate_bps: v.gstRateBps,
        prices_include_tax: v.pricesIncludeTax,
        service_charge_enabled: v.serviceChargeEnabled,
        service_charge_bps: percentToBps(v.serviceChargePercent) ?? 0,
        gstin: empty(v.gstin),
        fssai_license: empty(v.fssaiLicense),
      };
    }
    case 'bill': {
      const v = values as z.output<typeof billTabSchema>;
      return {
        invoice_prefix: v.invoicePrefix,
        paper_width: v.paperWidth,
        bill_footer_text: empty(v.billFooterText),
        print_waiter_on_bill: v.printWaiterOnBill,
        show_upi_qr_on_bill: v.showUpiQrOnBill,
        upi_vpa: empty(v.upiVpa),
        upi_payee_name: empty(v.upiPayeeName),
      };
    }
    case 'ordering': {
      const v = values as z.output<typeof orderingTabSchema>;
      return {
        require_first_order_approval: v.requireFirstOrderApproval,
        customer_cancel_window_seconds: v.customerCancelWindowSeconds,
        reopen_window_minutes: v.reopenWindowMinutes,
        business_day_start_hour: v.businessDayStartHour,
        max_tables_per_waiter: v.maxTablesPerWaiter,
        staff_can_remove_served_items: v.staffCanRemoveServedItems,
      };
    }
  }
}
