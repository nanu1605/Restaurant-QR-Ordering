import { z } from 'zod';

import {
  IDEMPOTENCY_KEY_PATTERN,
  MAX_LINE_NOTE,
  MAX_LINE_QUANTITY,
  MAX_ORDER_LINES,
  MAX_ORDER_NOTE,
  QR_TOKEN_PATTERN,
} from './limits';

/** Server-side validation of what a customer phone sends (spec §9.6). */

export const qrTokenSchema = z.string().regex(QR_TOKEN_PATTERN);

const optionalNote = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((note) => note || null)
    .nullable()
    .optional();

export const orderLineSchema = z.object({
  menuItemId: z.uuid(),
  variantId: z.uuid().nullable(),
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  note: optionalNote(MAX_LINE_NOTE),
});

export const placeOrderSchema = z.object({
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
  lines: z.array(orderLineSchema).min(1).max(MAX_ORDER_LINES),
  note: optionalNote(MAX_ORDER_NOTE),
});

export type PlaceOrderInput = z.input<typeof placeOrderSchema>;

/** The payload customer_place_order expects. */
export function toOrderItemsPayload(lines: z.output<typeof orderLineSchema>[]) {
  return lines.map((line) => ({
    menu_item_id: line.menuItemId,
    variant_id: line.variantId,
    quantity: line.quantity,
    note: line.note ?? null,
  }));
}
