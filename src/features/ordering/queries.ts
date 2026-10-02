import 'server-only';

import { cache } from 'react';
import { z } from 'zod';

import { publicImageUrl } from '@/features/menu/images';
import { dbErrorCode } from '@/lib/db-errors';
import { getPublicEnv } from '@/lib/env';
import { ORDER_ITEM_STATUSES } from '@/lib/order-status';
import { createAdminClient } from '@/lib/supabase/admin';
import { Constants } from '@/types/database';

import { canChoose } from './addons';
import { getLang } from './lang';
import { QR_TOKEN_PATTERN } from './limits';
import { localName } from './localize';
import type { Lang } from './strings';
import type { CustomerAddonGroup, CustomerSessionView, CustomerTable } from './types';

/**
 * Customer reads (spec §9.2): the server calls the customer_* functions with the
 * service role on the phone's behalf. The JSON they return is parsed here, so a
 * schema drift fails loudly instead of rendering nonsense.
 */

const foodType = z.enum(Constants.public.Enums.food_type);

const tableJson = z.object({
  restaurant: z.object({
    name: z.string(),
    logo_path: z.string().nullable(),
    logo_version: z.string(),
    accent_color: z.string(),
    timezone: z.string(),
  }),
  table: z.object({ label: z.string() }),
  access_state: z.enum(['full', 'read_only']),
  ordering: z.object({
    require_first_order_approval: z.boolean(),
    cancel_window_seconds: z.number().int(),
  }),
  menu: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      name_hi: z.string().nullish(),
      items: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          name_hi: z.string().nullish(),
          description: z.string().nullable(),
          food_type: foodType,
          price_paise: z.number().int(),
          image_path: z.string().nullable(),
          image_version: z.string(),
          is_available: z.boolean(),
          variants: z.array(
            z.object({ id: z.string(), name: z.string(), price_paise: z.number().int() }),
          ),
          addon_group_ids: z.array(z.string()),
        }),
      ),
    }),
  ),
  addon_groups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      min_select: z.number().int(),
      max_select: z.number().int(),
      addons: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          price_paise: z.number().int(),
          is_available: z.boolean(),
        }),
      ),
    }),
  ),
  session: z.object({ order_count: z.number().int() }).nullable(),
});

const sessionJson = z.object({
  now: z.string(),
  timezone: z.string(),
  cancel_window_seconds: z.number().int(),
  access_state: z.enum(['full', 'read_only']),
  last_session_billed: z.boolean(),
  session: z
    .object({
      opened_at: z.string(),
      rounds: z.array(
        z.object({
          id: z.string(),
          round_number: z.number().int(),
          status: z.enum(Constants.public.Enums.order_status),
          placed_at: z.string(),
          is_mine: z.boolean(),
          customer_note: z.string().nullable(),
          reject_reason: z.string().nullable(),
          removed_reason: z.string().nullable(),
          items: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              name_hi: z.string().nullish(),
              variant: z.string().nullable(),
              addons: z.array(z.string()),
              food_type: foodType,
              quantity: z.number().int(),
              unit_price_paise: z.number().int(),
              note: z.string().nullable(),
              status: z.enum(ORDER_ITEM_STATUSES),
              removed_reason: z.string().nullable(),
              cancellable_until: z.string().nullable(),
            }),
          ),
        }),
      ),
    })
    .nullable(),
});

export function toCustomerTable(json: unknown, lang: Lang = 'en'): CustomerTable {
  const data = tableJson.parse(json);
  const supabaseUrl = getPublicEnv().NEXT_PUBLIC_SUPABASE_URL;
  const groups = new Map<string, CustomerAddonGroup>(
    data.addon_groups.map((group) => [
      group.id,
      {
        id: group.id,
        name: group.name,
        minSelect: group.min_select,
        maxSelect: group.max_select,
        addons: group.addons.map((addon) => ({
          id: addon.id,
          name: addon.name,
          pricePaise: addon.price_paise,
          isAvailable: addon.is_available,
        })),
      },
    ]),
  );
  return {
    restaurant: {
      name: data.restaurant.name,
      logoUrl: data.restaurant.logo_path
        ? publicImageUrl(
            supabaseUrl,
            'logos',
            data.restaurant.logo_path,
            data.restaurant.logo_version,
          )
        : null,
      accentColor: data.restaurant.accent_color,
      timezone: data.restaurant.timezone,
    },
    tableLabel: data.table.label,
    canOrder: data.access_state === 'full',
    requireApproval: data.ordering.require_first_order_approval,
    cancelWindowSeconds: data.ordering.cancel_window_seconds,
    menu: data.menu.map((category) => ({
      id: category.id,
      ...localName(category.name, category.name_hi, lang),
      items: category.items.map((item) => {
        const addonGroups = item.addon_group_ids.flatMap((id) => groups.get(id) ?? []);
        return {
          id: item.id,
          ...localName(item.name, item.name_hi, lang),
          description: item.description,
          foodType: item.food_type,
          pricePaise: item.price_paise,
          imageUrl: item.image_path
            ? publicImageUrl(supabaseUrl, 'menu-images', item.image_path, item.image_version)
            : null,
          isAvailable: item.is_available && addonGroups.every(canChoose),
          variants: item.variants.map((variant) => ({
            id: variant.id,
            name: variant.name,
            pricePaise: variant.price_paise,
          })),
          addonGroups,
        };
      }),
    })),
    sessionOrderCount: data.session?.order_count ?? null,
  };
}

export function toCustomerSession(json: unknown, lang: Lang = 'en'): CustomerSessionView {
  const data = sessionJson.parse(json);
  return {
    now: data.now,
    timezone: data.timezone,
    cancelWindowSeconds: data.cancel_window_seconds,
    canOrder: data.access_state === 'full',
    lastSessionBilled: data.last_session_billed,
    rounds:
      data.session?.rounds.map((round) => ({
        id: round.id,
        roundNumber: round.round_number,
        status: round.status,
        placedAt: round.placed_at,
        isMine: round.is_mine,
        customerNote: round.customer_note,
        rejectReason: round.reject_reason,
        removedReason: round.removed_reason,
        items: round.items.map((item) => ({
          id: item.id,
          name: localName(item.name, item.name_hi, lang).name,
          variant: item.variant,
          addons: item.addons,
          foodType: item.food_type,
          quantity: item.quantity,
          unitPricePaise: item.unit_price_paise,
          note: item.note,
          status: item.status,
          removedReason: item.removed_reason,
          cancellableUntil: item.cancellable_until,
        })),
      })) ?? null,
  };
}

/** The table and its menu, or null when the QR code doesn't work (unknown, off or regenerated). */
export const getCustomerTable = cache(async (qrToken: string): Promise<CustomerTable | null> => {
  if (!QR_TOKEN_PATTERN.test(qrToken)) return null;
  const { data, error } = await createAdminClient().rpc('customer_get_table', {
    p_qr_token: qrToken,
  });
  if (error) {
    if (dbErrorCode(error) === 'TABLE_NOT_FOUND') return null;
    throw new Error(`customer_get_table failed: ${error.code} ${error.message}`);
  }
  return toCustomerTable(data, await getLang());
});

/** The table's open session as this phone sees it, or null when the QR code doesn't work. */
export async function getCustomerSession(
  qrToken: string,
  deviceId: string | null,
): Promise<CustomerSessionView | null> {
  if (!QR_TOKEN_PATTERN.test(qrToken)) return null;
  const { data, error } = await createAdminClient().rpc('customer_get_session', {
    p_qr_token: qrToken,
    ...(deviceId ? { p_device_id: deviceId } : {}),
  });
  if (error) {
    if (dbErrorCode(error) === 'TABLE_NOT_FOUND') return null;
    throw new Error(`customer_get_session failed: ${error.code} ${error.message}`);
  }
  return toCustomerSession(data, await getLang());
}
