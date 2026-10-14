import { z } from 'zod';

import { CUISINE_SETS } from '@/features/menu/default-categories';
import { parsePriceInput } from '@/features/menu/schemas';
import { FEATURE_KEYS, type FeatureKey } from '@/features/plans/plan-features';
import { GST_RATES_BPS } from '@/features/settings/schemas';
import { RESTAURANT_CODE_PATTERN, USERNAME_PATTERN } from '@/lib/auth/staff-email';
import { addDays, isDate } from '@/lib/date-range';

import { ACQUISITION_CHANNELS, MANUAL_MODES } from './platform';

/** Super-admin forms (spec §13.4), shared by the dialogs and the server actions. */

export const restaurantIdSchema = z.uuid();

export const suspendSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Say why, for the audit log and the owner.')
    .max(300, 'Use 300 characters or fewer.'),
});
export type SuspendInput = z.input<typeof suspendSchema>;

export const extendTrialSchema = z.object({
  days: z.coerce
    .number({ message: 'Enter a number of days.' })
    .int('Enter whole days.')
    .min(1, 'At least 1 day.')
    .max(90, 'At most 90 days at a time.'),
});
export type ExtendTrialInput = z.input<typeof extendTrialSchema>;

export const changePlanSchema = z.object({
  planCode: z.string().regex(/^[a-z_]{2,30}$/, 'Choose a plan.'),
});
export type ChangePlanInput = z.input<typeof changePlanSchema>;

export const manualPaymentSchema = z
  .object({
    // A setup fee has no billing cycle or period (docs/DECISIONS.md SA-8).
    purpose: z.enum(['subscription', 'setup_fee']).default('subscription'),
    amount: z
      .string()
      .trim()
      .refine((text) => (parsePriceInput(text) ?? 0) > 0, 'Enter the amount in rupees, e.g. 899.'),
    mode: z.enum(MANUAL_MODES, { message: 'Choose how it was paid.' }),
    billingCycle: z.enum(['monthly', 'yearly'], { message: 'Choose monthly or yearly.' }),
    // Checked below, and only for a subscription: a setup fee hides them.
    periodStart: z.string(),
    periodEnd: z.string(),
    notes: z.string().trim().max(500, 'Use 500 characters or fewer.'),
  })
  .superRefine((value, ctx) => {
    if (value.purpose === 'setup_fee') return;
    for (const key of ['periodStart', 'periodEnd'] as const) {
      if (!isDate(value[key]))
        ctx.addIssue({ code: 'custom', path: [key], message: 'Choose a date.' });
    }
    if (
      isDate(value.periodStart) &&
      isDate(value.periodEnd) &&
      value.periodEnd < value.periodStart
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['periodEnd'],
        message: 'The last day is on or after the first.',
      });
    }
  });
export type ManualPaymentInput = z.input<typeof manualPaymentSchema>;

// A Razorpay Payment Link MenuMesh sends (spec §14.5, docs/DECISIONS.md P8-5, P8-11).
export const paymentLinkSchema = z
  .object({
    purpose: z.enum(['subscription', 'setup_fee'], { message: 'Choose what it is for.' }),
    amount: z
      .string()
      .trim()
      .refine((text) => {
        const paise = parsePriceInput(text) ?? 0;
        return paise >= 100 && paise <= 100_000_000;
      }, 'Enter ₹1 to ₹10,00,000 in rupees, e.g. 1499.'),
    // Only a subscription link has months; the field is hidden for a setup fee.
    months: z.unknown().transform(Number),
    description: z
      .string()
      .trim()
      .min(1, 'Say what the payment is for.')
      .max(200, 'Use 200 characters or fewer.'),
  })
  .superRefine(({ purpose, months }, ctx) => {
    if (purpose === 'subscription' && !(Number.isInteger(months) && months >= 1 && months <= 24)) {
      ctx.addIssue({ code: 'custom', path: ['months'], message: 'Enter 1 to 24 whole months.' });
    }
  });
export type PaymentLinkInput = z.input<typeof paymentLinkSchema>;

/**
 * The last day of a period starting on `start`: the day before the same date
 * a month (or year) later, or the last day of that month when the date doesn't
 * exist there (31 Jan → 28 Feb).
 */
export function periodEnd(start: string, cycle: 'monthly' | 'yearly'): string {
  const [year, month, day] = start.split('-').map(Number) as [number, number, number];
  const targetYear = cycle === 'yearly' ? year + 1 : year + Math.floor(month / 12);
  const targetMonth = cycle === 'yearly' ? month - 1 : month % 12; // 0-based
  const daysInTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  if (day > daysInTarget) {
    return new Date(Date.UTC(targetYear, targetMonth, daysInTarget)).toISOString().slice(0, 10);
  }
  return addDays(new Date(Date.UTC(targetYear, targetMonth, day)).toISOString().slice(0, 10), -1);
}

// Supabase Auth hashes with bcrypt, which only reads the first 72 bytes.
// The website's signup passes its own words.
export function passwordRule(
  short = 'Use at least 8 characters.',
  long = 'Use 72 characters or fewer.',
) {
  return z.string().min(8, short).max(72, long);
}

export const passwordSchema = passwordRule();

export const ownerPasswordSchema = z.object({ password: passwordSchema });
export type OwnerPasswordInput = z.input<typeof ownerPasswordSchema>;

/**
 * A password that is easy to read out or type from a handover card: no
 * look-alike characters (0/O, 1/l/I).
 */
export function generatePassword(length = 12): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
}

// ─── Onboarding wizard (spec §13.4, docs/DECISIONS.md P7-9) ─────────────────
const GST_RATE_OPTIONS: readonly number[] = GST_RATES_BPS;
const optionalText = (max: number) => z.string().trim().max(max, `Use ${max} characters or fewer.`);

export const onboardDetailsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter the restaurant name.')
    .max(120, 'Use 120 characters or fewer.'),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      RESTAURANT_CODE_PATTERN,
      'Use 3–32 lowercase letters, numbers or hyphens, starting and ending with a letter or number.',
    ),
  cuisine: z.enum(CUISINE_SETS, { message: 'Choose a menu style.' }),
  acquisitionChannel: z.enum(ACQUISITION_CHANNELS, {
    message: 'Choose how they found MenuMesh.',
  }),
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
});

export const onboardOwnerSchema = z.object({
  ownerName: z
    .string()
    .trim()
    .min(1, "Enter the owner's name.")
    .max(80, 'Use 80 characters or fewer.'),
  ownerUsername: z
    .string()
    .trim()
    .toLowerCase()
    .regex(USERNAME_PATTERN, 'Use 3–30 lowercase letters, numbers or underscores.'),
  ownerEmail: z
    .string()
    .trim()
    .refine((value) => value === '' || z.email().safeParse(value).success, 'Enter a valid email.'),
  ownerPassword: passwordSchema,
});

export const onboardTaxSchema = z.object({
  gstMode: z.enum(['none', 'regular', 'composition']),
  gstRateBps: z.number().refine((bps) => GST_RATE_OPTIONS.includes(bps), 'Choose a GST rate.'),
  pricesIncludeTax: z.boolean(),
});

export const onboardPlanSchema = z.object({
  plan: z.string().regex(/^[a-z_]{2,30}$/, 'Choose a plan.'),
  trialDays: z.coerce
    .number({ message: 'Enter a number of days.' })
    .int('Enter whole days.')
    .min(1, 'At least 1 day.')
    .max(365, 'At most 365 days.'),
});

export const onboardSchema = z.object({
  ...onboardDetailsSchema.shape,
  ...onboardOwnerSchema.shape,
  ...onboardTaxSchema.shape,
  ...onboardPlanSchema.shape,
});
export type OnboardFormInput = z.input<typeof onboardSchema>;

/** The wizard's steps and the fields each one checks before moving on. */
export const ONBOARD_STEPS = [
  { key: 'details', title: 'Restaurant', fields: Object.keys(onboardDetailsSchema.shape) },
  { key: 'owner', title: 'Owner login', fields: Object.keys(onboardOwnerSchema.shape) },
  { key: 'tax', title: 'Tax', fields: Object.keys(onboardTaxSchema.shape) },
  { key: 'plan', title: 'Plan and trial', fields: Object.keys(onboardPlanSchema.shape) },
] as const;

/** "Sharma's Dhaba & Grill" → "sharmas-dhaba-grill" (a restaurant code to edit). */
export function suggestRestaurantCode(name: string): string {
  const code = name
    .toLowerCase()
    .normalize('NFKD')
    // Accent marks split off by NFKD: "café" → "cafe".
    .replace(/\p{M}/gu, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return code.length >= 3 ? code : '';
}

// ─── Plans editor (spec §13.4, docs/DECISIONS.md P7-10) ─────────────────────
const rupeesSchema = z
  .string()
  .trim()
  .refine((text) => parsePriceInput(text) !== null, 'Enter an amount in rupees, e.g. 899.');
const limitSchema = z
  .string()
  .trim()
  .refine(
    (text) => text === '' || (/^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 10000),
    'Leave empty for unlimited, or enter 1 to 10,000.',
  );
const razorpayIdSchema = z
  .string()
  .trim()
  .refine(
    (text) => text === '' || /^[A-Za-z0-9_]{1,60}$/.test(text),
    'Paste the id, e.g. plan_Nx12.',
  );

export const planFormSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(40, 'Use 40 characters or fewer.'),
  priceMonthly: rupeesSchema,
  priceYearly: rupeesSchema,
  maxTables: limitSchema,
  maxStaff: limitSchema,
  features: z.object(
    Object.fromEntries(FEATURE_KEYS.map((key) => [key, z.boolean()])) as Record<
      FeatureKey,
      z.ZodBoolean
    >,
  ),
  razorpayMonthly: razorpayIdSchema,
  razorpayYearly: razorpayIdSchema,
  isActive: z.boolean(),
  sortOrder: z.coerce
    .number({ message: 'Enter a number.' })
    .int('Enter a whole number.')
    .min(0, '0 or more.')
    .max(1000, '1000 or less.'),
});
export type PlanFormInput = z.input<typeof planFormSchema>;

// ─── Platform settings (docs/DECISIONS.md SA-4, SA-5) ───────────────────────
// A cleared box is refused, not read as 0 (Number('') is 0).
const daysSchema = (min: number, max: number) =>
  z
    .union([z.number(), z.string().trim().min(1, 'Enter a number.')])
    .transform(Number)
    .pipe(
      z
        .number({ message: 'Enter a number.' })
        .int('Enter a whole number.')
        .min(min, `${min} or more.`)
        .max(max, `${max} or less.`),
    );

export const platformSettingsSchema = z
  .object({
    trialDays: daysSchema(1, 365),
    graceDays: daysSchema(0, 90),
    setupFee: rupeesSchema.refine((text) => (parsePriceInput(text) ?? 0) >= 100, 'At least ₹1.'),
    setupFeeDiscount: rupeesSchema,
    discountLastDay: z.string().refine((text) => text === '' || isDate(text), 'Choose a date.'),
    supportPhone: optionalText(20),
    supportEmail: z
      .string()
      .trim()
      .max(254, 'Use 254 characters or fewer.')
      .refine(
        (value) => value === '' || z.email().safeParse(value).success,
        'Enter a valid email.',
      ),
  })
  .refine(
    (input) =>
      (parsePriceInput(input.setupFeeDiscount) ?? 0) < (parsePriceInput(input.setupFee) ?? 0),
    { message: 'Keep the discount below the fee.', path: ['setupFeeDiscount'] },
  );
export type PlatformSettingsInput = z.input<typeof platformSettingsSchema>;
