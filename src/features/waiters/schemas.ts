import { z } from 'zod';

import { passwordSchema, usernameSchema } from '@/features/staff/schemas';

/** Waiter profile form (spec §8.2 waiters, §13.3 Waiters). */

/** "+91 98765 43210", "098765-43210", "9876543210" → "9876543210"; null if not an Indian mobile. */
export function normalizeIndianMobile(input: string): string | null {
  let digits = input.replace(/[\s()-]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

export const WAITER_LOGIN_MODES = ['none', 'link', 'create'] as const;

export const waiterFormSchema = z
  .object({
    id: z.uuid().optional(),
    fullName: z
      .string()
      .trim()
      .min(1, "Enter the waiter's name.")
      .max(80, 'Use 80 characters or fewer.'),
    phone: z
      .string()
      .trim()
      .refine((value) => value === '' || normalizeIndianMobile(value) !== null, {
        message: 'Enter a 10-digit mobile number.',
      }),
    employeeCode: z.string().trim().max(30, 'Use 30 characters or fewer.'),
    joinedOn: z
      .string()
      .refine((value) => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value), 'Enter a valid date.'),
    notes: z.string().trim().max(300, 'Use 300 characters or fewer.'),
    loginMode: z.enum(WAITER_LOGIN_MODES),
    memberId: z.string(),
    username: z.string(),
    password: z.string(),
  })
  .superRefine((waiter, ctx) => {
    if (waiter.loginMode === 'link' && !z.uuid().safeParse(waiter.memberId).success) {
      ctx.addIssue({ code: 'custom', path: ['memberId'], message: 'Choose a waiter login.' });
    }
    if (waiter.loginMode === 'create') {
      const username = usernameSchema.safeParse(waiter.username);
      if (!username.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['username'],
          message: username.error.issues[0].message,
        });
      }
      const password = passwordSchema.safeParse(waiter.password);
      if (!password.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['password'],
          message: password.error.issues[0].message,
        });
      }
    }
  });

export type WaiterForm = z.input<typeof waiterFormSchema>;
