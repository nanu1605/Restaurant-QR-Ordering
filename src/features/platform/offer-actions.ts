'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';

import {
  actionError,
  actionOk,
  fromDbError,
  fromZodError,
  type ActionResult,
} from '@/lib/action-result';
import { requirePlatformPermission } from '@/lib/auth/guards';
import { GENERIC_ERROR } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

import {
  dealPayload,
  dealSchema,
  offerEditSchema,
  offerPayload,
  offerSchema,
  overridePayload,
  overrideSchema,
  type DealInput,
  type OfferEditInput,
  type OfferInput,
  type OverrideInput,
} from './offers';
import { restaurantIdSchema } from './schemas';
import { discountEndsAt } from './setup-fee';

/**
 * Offers, one restaurant's price and overrides (docs/SUPER_ADMIN_PLAN.md 14b,
 * docs/DECISIONS.md SA-77+). Each checks its permission here and again in SQL:
 * offers settings.manage, prices money.record, overrides restaurants.manage.
 */

const idSchema = z.uuid();

export async function createOffer(input: OfferInput): Promise<ActionResult> {
  await requirePlatformPermission('settings.manage');
  const parsed = offerSchema.safeParse(input);
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_save_offer', {
    p_offer: offerPayload(parsed.data),
  });
  if (error) return fromDbError(error, 'platform_save_offer');
  refresh();
  return actionOk();
}

/** Its description, last day or most uses; the terms stay as they were made. */
export async function editOffer(offerId: string, input: OfferEditInput): Promise<ActionResult> {
  await requirePlatformPermission('settings.manage');
  const id = idSchema.safeParse(offerId);
  const parsed = offerEditSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_save_offer', {
    p_offer_id: id.data,
    p_offer: {
      description: parsed.data.description || null,
      valid_until: parsed.data.validUntil ? discountEndsAt(parsed.data.validUntil) : null,
      max_redemptions: parsed.data.maxRedemptions ? Number(parsed.data.maxRedemptions) : null,
    },
  });
  if (error) return fromDbError(error, 'platform_save_offer');
  refresh();
  return actionOk();
}

/** Nobody new can use it; restaurants already paying its price carry on. */
export async function endOffer(offerId: string): Promise<ActionResult> {
  await requirePlatformPermission('settings.manage');
  const id = idSchema.safeParse(offerId);
  if (!id.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_save_offer', {
    p_offer_id: id.data,
    p_offer: { ended: true },
  });
  if (error) return fromDbError(error, 'platform_save_offer');
  refresh();
  return actionOk();
}

/** An offer code or a custom price for one restaurant. */
export async function setDeal(
  restaurantId: string,
  input: DealInput,
): Promise<ActionResult<{ appliedNow: boolean }>> {
  await requirePlatformPermission('money.record');
  const id = restaurantIdSchema.safeParse(restaurantId);
  const parsed = dealSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_set_deal', {
    p_restaurant_id: id.data,
    p_deal: dealPayload(parsed.data),
  });
  if (error) return fromDbError(error, 'platform_set_deal');
  refresh();
  return actionOk({ appliedNow: (data as { applied_now: boolean }).applied_now });
}

/** Back to the list price; an autopay already charging it carries on. */
export async function endDeal(
  restaurantId: string,
): Promise<ActionResult<{ stillCharged: boolean }>> {
  await requirePlatformPermission('money.record');
  const id = restaurantIdSchema.safeParse(restaurantId);
  if (!id.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_set_deal', {
    p_restaurant_id: id.data,
    p_deal: { end: true },
  });
  if (error) return fromDbError(error, 'platform_set_deal');
  refresh();
  return actionOk({ stillCharged: (data as { still_charged: boolean }).still_charged });
}

export async function setOverride(
  restaurantId: string,
  input: OverrideInput,
): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.manage');
  const id = restaurantIdSchema.safeParse(restaurantId);
  const parsed = overrideSchema.safeParse(input);
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_set_override', {
    p_restaurant_id: id.data,
    p_override: overridePayload(parsed.data),
  });
  if (error) return fromDbError(error, 'platform_set_override');
  refresh();
  return actionOk();
}

export async function removeOverride(overrideId: string): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.manage');
  const id = idSchema.safeParse(overrideId);
  if (!id.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_remove_override', { p_override_id: id.data });
  if (error) return fromDbError(error, 'platform_remove_override');
  refresh();
  return actionOk();
}
