import { z } from 'zod';

import { parsePriceInput } from '@/features/menu/schemas';
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
