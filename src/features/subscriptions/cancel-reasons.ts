import { z } from 'zod';

/** Why an owner turned autopay off (docs/SUPER_ADMIN_PLAN.md §4.3, DECISIONS SA-15). */
export const CANCEL_REASONS = [
  'too_expensive',
  'not_using',
  'missing_feature',
  'closing',
  'switching',
  'other',
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export const CANCEL_REASON_LABELS: Record<CancelReason, string> = {
  too_expensive: 'Too expensive',
  not_using: 'Not using it enough',
  missing_feature: 'Missing a feature',
  closing: 'Restaurant closing',
  switching: 'Moving to another system',
  other: 'Other',
};

export const cancelReasonSchema = z
  .object({
    reason: z.enum(CANCEL_REASONS, { message: 'Choose a reason.' }),
    detail: z.string().trim().max(300, 'Use 300 characters or fewer.'),
  })
  .refine((value) => value.reason !== 'other' || value.detail !== '', {
    path: ['detail'],
    message: 'Tell us a little more.',
  });
export type CancelReasonInput = z.input<typeof cancelReasonSchema>;
