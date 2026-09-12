import 'server-only';

import { cache } from 'react';

import { createClient } from '@/lib/supabase/server';

import { parsePlanFeatures, type PlanFeatures } from './plan-features';

/**
 * The restaurant's plan limits and features (the trialled plan during a
 * trial), once per request. Works for every member role.
 */
export const getPlanFeatures = cache(async (restaurantId: string): Promise<PlanFeatures> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('restaurant_plan', { p_restaurant_id: restaurantId });
  if (error) throw new Error(`Could not load the plan: ${error.message}`);
  return parsePlanFeatures(data?.[0]);
});
