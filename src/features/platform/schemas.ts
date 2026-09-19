import { z } from 'zod';

import { CUISINE_SETS } from '@/features/menu/default-categories';
import { parsePriceInput } from '@/features/menu/schemas';
import { GST_RATES_BPS } from '@/features/settings/schemas';
import { RESTAURANT_CODE_PATTERN, USERNAME_PATTERN } from '@/lib/auth/staff-email';
import { addDays, isDate } from '@/lib/date-range';

import { MANUAL_MODES } from './platform';

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

const dateSchema = z.string().refine(isDate, 'Choose a date.');

export const manualPaymentSchema = z
  .object({
    amount: z
      .string()
      .trim()
      .refine((text) => (parsePriceInput(text) ?? 0) > 0, 'Enter the amount in rupees, e.g. 899.'),
    mode: z.enum(MANUAL_MODES, { message: 'Choose how it was paid.' }),
    billingCycle: z.enum(['monthly', 'yearly'], { message: 'Choose monthly or yearly.' }),
    periodStart: dateSchema,
    periodEnd: dateSchema,
    notes: z.string().trim().max(500, 'Use 500 characters or fewer.'),
  })
  .refine((value) => value.periodEnd >= value.periodStart, {
    path: ['periodEnd'],
    message: 'The last day is on or after the first.',
  });
export type ManualPaymentInput = z.input<typeof manualPaymentSchema>;

/** The last day of a period starting on `start`: a month or a year, less a day. */
export function periodEnd(start: string, cycle: 'monthly' | 'yearly'): string {
  const [year, month, day] = start.split('-').map(Number) as [number, number, number];
  const next =
    cycle === 'yearly'
      ? new Date(Date.UTC(year + 1, month - 1, day))
      : new Date(Date.UTC(year, month, day));
  return addDays(next.toISOString().slice(0, 10), -1);
}

// Supabase Auth hashes with bcrypt, which only reads the first 72 bytes.
export const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(72, 'Use 72 characters or fewer.');

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
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return code.length >= 3 ? code : '';
}
