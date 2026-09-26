'use server';

import { cookies } from 'next/headers';
import { z } from 'zod';

import { actionError, actionOk, type ActionResult } from '@/lib/action-result';
import { dbErrorCode, type DbErrorLike } from '@/lib/db-errors';
import { getPublicEnv } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import { Constants } from '@/types/database';

import { refusedLines } from './addons';
import { ensureDeviceId, readDeviceId } from './device';
import { deviceCookieOptions } from './device-token';
import { getStrings } from './lang';
import { getCustomerTable } from './queries';
import {
  placeOrderSchema,
  qrTokenSchema,
  toOrderItemsPayload,
  type PlaceOrderInput,
} from './schemas';
import { LANG_COOKIE, refusalMessage, type Strings } from './strings';
import type { OrderStatus } from './types';

/**
 * Customer server actions (spec §5.1): the phone never talks to the database.
 * The device id always comes from the signed cookie, never from the client.
 */

function customerError(t: Strings, error: DbErrorLike, context: string) {
  const known = refusalMessage(t.errors, dbErrorCode(error));
  if (known) return actionError(known);
  console.error(`${context} failed:`, error.code, error.message, error.details);
  return actionError(t.genericError);
}

const placedOrderJson = z.object({
  round_number: z.number().int(),
  status: z.enum(Constants.public.Enums.order_status),
});

export type PlaceOrderResult =
  | { ok: true; data: { roundNumber: number; status: OrderStatus } }
  /** unavailableLines: indexes of the sent lines to take out of the cart. */
  | { ok: false; error: string; unavailableLines?: number[] };

export async function placeOrder(
  qrToken: string,
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  const t = await getStrings();
  if (!qrTokenSchema.safeParse(qrToken).success) return actionError(t.errors.TABLE_NOT_FOUND);
  const parsed = placeOrderSchema.safeParse(input);
  if (!parsed.success) return actionError(t.errors.INVALID_INPUT);

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
      const table = await getCustomerTable(qrToken).catch(() => null);
      return {
        ok: false,
        error: t.errors.ITEM_UNAVAILABLE,
        unavailableLines: refusedLines(
          table?.menu ?? [],
          parsed.data.lines,
          (error.details ?? '').split(',').filter(Boolean),
        ),
      };
    }
    return customerError(t, error, 'customer_place_order');
  }

  const placed = placedOrderJson.parse(data);
  return actionOk({ roundNumber: placed.round_number, status: placed.status });
}

export async function cancelOrderItem(qrToken: string, orderItemId: string): Promise<ActionResult> {
  const t = await getStrings();
  if (!qrTokenSchema.safeParse(qrToken).success) return actionError(t.errors.TABLE_NOT_FOUND);
  if (!z.uuid().safeParse(orderItemId).success) return actionError(t.errors.NOT_FOUND);

  // Without a device cookie this phone can't have ordered anything.
  const deviceId = await readDeviceId();
  if (!deviceId) return actionError(t.errors.NOT_YOUR_ITEM);

  const { error } = await createAdminClient().rpc('customer_cancel_item', {
    p_qr_token: qrToken,
    p_device_id: deviceId,
    p_order_item_id: orderItemId,
  });
  if (error) return customerError(t, error, 'customer_cancel_item');
  return actionOk();
}

/** Call a waiter or ask for the bill (spec §8.7, P9-1). Tapping again is harmless. */
export async function requestService(
  qrToken: string,
  type: 'call_waiter' | 'request_bill',
): Promise<ActionResult> {
  const t = await getStrings();
  if (!qrTokenSchema.safeParse(qrToken).success) return actionError(t.errors.TABLE_NOT_FOUND);
  if (type !== 'call_waiter' && type !== 'request_bill') return actionError(t.errors.INVALID_INPUT);

  const deviceId = await ensureDeviceId();
  const { error } = await createAdminClient().rpc('customer_create_service_request', {
    p_qr_token: qrToken,
    p_device_id: deviceId,
    p_type: type,
  });
  if (error) {
    // Service requests word these their own way; the ordering messages talk about orders.
    const own = refusalMessage(t.requestErrors, dbErrorCode(error));
    return own ? actionError(own) : customerError(t, error, 'customer_create_service_request');
  }
  return actionOk();
}

/**
 * The हिन्दी/English switch in the customer header (spec §19 Phase 9,
 * docs/DECISIONS.md P9-7): remembered on this phone; the page re-renders in it.
 */
export async function setLanguage(formData: FormData): Promise<void> {
  const options = deviceCookieOptions(getPublicEnv().NEXT_PUBLIC_APP_URL);
  (await cookies()).set(LANG_COOKIE, formData.get('lang') === 'hi' ? 'hi' : 'en', options);
}
