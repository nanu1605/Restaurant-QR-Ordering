import { z } from 'zod';

import { placeOrderSchema } from '@/features/ordering/schemas';

/** Server-side validation for the live board's actions (spec §9.6). */

export const MAX_REASON = 200;

export const reasonSchema = z
  .string()
  .trim()
  .min(1, 'Choose or type a reason.')
  .max(MAX_REASON, `Keep the reason under ${MAX_REASON} characters.`);

/** Statuses staff can move a dish to (spec §10.3: forward only). */
export const forwardStatusSchema = z.enum(['preparing', 'ready', 'served']);
export type ForwardStatus = z.infer<typeof forwardStatusSchema>;

export const idSchema = z.uuid();

export const itemIdsSchema = z.array(z.uuid()).min(1).max(100);

export const removeItemSchema = z.object({
  itemId: z.uuid(),
  quantity: z.number().int().min(1).max(20),
  reason: reasonSchema,
});

export type RemoveItemInput = z.input<typeof removeItemSchema>;

/** A staff order is a customer order plus the table it's for (spec §9.3). */
export const staffOrderSchema = placeOrderSchema.extend({ tableId: z.uuid() });

export type StaffOrderInput = z.input<typeof staffOrderSchema>;

/** Reason presets (spec §13.2); "Other…" lets staff type their own. */
export const REJECT_REASONS = ['Prank / not seated', 'Items unavailable', 'Duplicate'] as const;

export const REMOVE_REASONS = [
  'Customer request',
  'Wrong item',
  'Out of stock',
  'Quality complaint',
] as const;
