'use server';

import { z } from 'zod';

import { actionError, actionOk, type ActionResult } from '@/lib/action-result';
import {
  CUSTOMER_GENERIC_ERROR,
  customerErrorMessage,
  dbErrorCode,
  type DbErrorLike,
} from '@/lib/db-errors';
import { createAdminClient } from '@/lib/supabase/admin';
import { Constants } from '@/types/database';

import { ensureDeviceId, readDeviceId } from './device';
import {
  placeOrderSchema,
  qrTokenSchema,
  toOrderItemsPayload,
  type PlaceOrderInput,
} from './schemas';
import type { OrderStatus } from './types';

/**
 * Customer server actions (spec §5.1): the phone never talks to the database.
 * The device id always comes from the signed cookie, never from the client.
 */

const message = (code: string) => customerErrorMessage({ code: 'P0001', message: code })!;

function customerError(error: DbErrorLike, context: string) {
  const known = customerErrorMessage(error);
  if (known) return actionError(known);
  console.error(`${context} failed:`, error.code, error.message, error.details);
  return actionError(CUSTOMER_GENERIC_ERROR);
}

const placedOrderJson = z.object({
  round_number: z.number().int(),
  status: z.enum(Constants.public.Enums.order_status),
});

export type PlaceOrderResult =
  | { ok: true; data: { roundNumber: number; status: OrderStatus } }
  | { ok: false; error: string; unavailableItemIds?: string[] };

export async function placeOrder(
  qrToken: string,
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  if (!qrTokenSchema.safeParse(qrToken).success) return actionError(message('TABLE_NOT_FOUND'));
  const parsed = placeOrderSchema.safeParse(input);
  if (!parsed.success) return actionError(message('INVALID_INPUT'));

  const deviceId = await ensureDeviceId();
  const { data, error } = await createAdminClient().rpc('customer_place_order', {
    p_qr_token: qrToken,
    p_device_id: deviceId,
    p_idempotency_key: parsed.data.idempotencyKey,
    p_items: toOrderItemsPayload(parsed.data.lines),
    p_note: parsed.data.note ?? undefined,
  });

  if (error) {
    if (dbErrorCode(error) === 'ITEM_UNAVAILABLE') {
      return {
        ok: false,
        error: message('ITEM_UNAVAILABLE'),
        unavailableItemIds: (error.details ?? '').split(',').filter(Boolean),
      };
    }
    return customerError(error, 'customer_place_order');
  }

  const placed = placedOrderJson.parse(data);
  return actionOk({ roundNumber: placed.round_number, status: placed.status });
}

export async function cancelOrderItem(qrToken: string, orderItemId: string): Promise<ActionResult> {
  if (!qrTokenSchema.safeParse(qrToken).success) return actionError(message('TABLE_NOT_FOUND'));
  if (!z.uuid().safeParse(orderItemId).success) return actionError(message('NOT_FOUND'));

  // Without a device cookie this phone can't have ordered anything.
  const deviceId = await readDeviceId();
  if (!deviceId) return actionError(message('NOT_YOUR_ITEM'));

  const { error } = await createAdminClient().rpc('customer_cancel_item', {
    p_qr_token: qrToken,
    p_device_id: deviceId,
    p_order_item_id: orderItemId,
  });
  if (error) return customerError(error, 'customer_cancel_item');
  return actionOk();
}

// Wording for service requests; the ordering messages talk about orders.
const REQUEST_MESSAGES: Record<string, string> = {
  NOTHING_TO_BILL: 'Order something first, then you can ask for the bill.',
  RATE_LIMITED: 'The staff have been called several times. Please wave to them instead.',
};

/** Call a waiter or ask for the bill (spec §8.7, P9-1). Tapping again is harmless. */
export async function requestService(
  qrToken: string,
  type: 'call_waiter' | 'request_bill',
): Promise<ActionResult> {
  if (!qrTokenSchema.safeParse(qrToken).success) return actionError(message('TABLE_NOT_FOUND'));
  if (type !== 'call_waiter' && type !== 'request_bill')
    return actionError(message('INVALID_INPUT'));

  const deviceId = await ensureDeviceId();
  const { error } = await createAdminClient().rpc('customer_create_service_request', {
    p_qr_token: qrToken,
    p_device_id: deviceId,
    p_type: type,
  });
  if (error) {
    const code = dbErrorCode(error);
    if (code && REQUEST_MESSAGES[code]) return actionError(REQUEST_MESSAGES[code]);
    return customerError(error, 'customer_create_service_request');
  }
  return actionOk();
}
