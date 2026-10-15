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
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/auth/guards';
import { GENERIC_ERROR } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

import { todayInIndia } from './platform';
import { restaurantIdSchema } from './schemas';
import {
  STANDEE_STEPS,
  standeePayload,
  standeeSchema,
  stepPatch,
  type StandeeInput,
  type StandeeStep,
} from './standees';

/**
 * The standee tracker (docs/DECISIONS.md SA-84, SA-85): the record is
 * restaurants.manage, its cost money.record; each again in SQL.
 */

export async function saveStandees(
  restaurantId: string,
  input: StandeeInput,
): Promise<ActionResult> {
  const [manage, record] = await Promise.all([
    hasPlatformPermission('restaurants.manage'),
    hasPlatformPermission('money.record'),
  ]);
  if (!manage && !record) await requirePlatformPermission('restaurants.manage');
  const id = restaurantIdSchema.safeParse(restaurantId);
  const parsed = standeeSchema.safeParse({ ...input, today: todayInIndia() });
  if (!id.success) return actionError(GENERIC_ERROR);
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_save_standees', {
    p_restaurant_id: id.data,
    p_standees: standeePayload(parsed.data, { manage, record }),
  });
  if (error) return fromDbError(error, 'platform_save_standees');
  refresh();
  return actionOk();
}

/** Marks the next step today, or makes the record ('start'). */
export async function markStandeeStep(
  restaurantId: string,
  step: StandeeStep | 'start',
): Promise<ActionResult> {
  await requirePlatformPermission('restaurants.manage');
  const id = restaurantIdSchema.safeParse(restaurantId);
  const which = z.enum(['start', ...STANDEE_STEPS]).safeParse(step);
  if (!id.success || !which.success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_save_standees', {
    p_restaurant_id: id.data,
    p_standees: stepPatch(which.data, todayInIndia()),
  });
  if (error) return fromDbError(error, 'platform_save_standees');
  refresh();
  return actionOk();
}
