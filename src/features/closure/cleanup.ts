import 'server-only';

import type { createAdminClient } from '@/lib/supabase/admin';

import { EXPORT_BUCKET } from './export';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Removes personal data of restaurants whose hold is over (docs/DECISIONS.md
 * SA-97), each in its own transaction: one that fails doesn't stop the others,
 * fails the nightly step so Home shows it, and is tried again tomorrow.
 */
export async function removeDuePersonalData(admin: Admin) {
  const { data: due, error } = await admin.rpc('closed_restaurants_due');
  if (error) throw new Error(`Could not list closed restaurants: ${error.message}`);
  const failed: string[] = [];
  for (const restaurantId of due) {
    const removed = await admin.rpc('closed_restaurant_remove_personal_data', {
      p_restaurant_id: restaurantId,
    });
    if (removed.error) {
      console.error('[closure] personal data not removed', restaurantId, removed.error);
      failed.push(`${restaurantId}: ${removed.error.message}`);
    }
  }
  if (failed.length > 0) throw new Error(`Not removed: ${failed.join('; ')}`);
  return { removed: due.length };
}

/** Export files past their link's 24 hours, pages of 500 until done. */
export async function removeOldExports(admin: Admin) {
  let deleted = 0;
  for (let round = 0; round < 20; round++) {
    const { data: paths, error } = await admin.rpc('restaurant_exports_to_remove', {
      p_limit: 500,
    });
    if (error) throw new Error(error.message);
    if (paths.length > 0) {
      const removed = await admin.storage.from(EXPORT_BUCKET).remove(paths);
      if (removed.error) throw new Error(removed.error.message);
    }
    deleted += paths.length;
    if (paths.length < 500) break;
  }
  return { deleted };
}
