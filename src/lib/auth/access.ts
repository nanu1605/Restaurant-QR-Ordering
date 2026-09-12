import 'server-only';

import { cache } from 'react';

import { createClient } from '@/lib/supabase/server';

export type RestaurantAccess = {
  state: 'full' | 'read_only';
  /** Why the restaurant is read-only (suspended, trial_ended, …). */
  reason: string | null;
  /** When ordering stops (next business-day start after the lapse). */
  restrictionAt: string | null;
  /** trial_ends_soon | subscription_ends_soon | payment_failed */
  warning: string | null;
};

/** Access state from restaurant_access() (spec §10.6), once per request. */
export const getRestaurantAccess = cache(
  async (restaurantId: string): Promise<RestaurantAccess> => {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('restaurant_access', {
      p_restaurant_id: restaurantId,
    });
    if (error) throw new Error(`Could not load access state: ${error.message}`);

    const row = data?.[0];
    return {
      state: row?.state === 'full' ? 'full' : 'read_only',
      reason: row?.reason ?? null,
      restrictionAt: row?.restriction_at ?? null,
      warning: row?.warning ?? null,
    };
  },
);
