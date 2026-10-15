import 'server-only';

import { cache } from 'react';

import { createClient } from '@/lib/supabase/server';

import { parseAnnouncements, parseBanners, type Panel } from './announcements';

/**
 * The banners a login sees now in a panel (docs/DECISIONS.md SA-82). A
 * failure shows none rather than stopping the panel.
 */
export const getBanners = cache(async (restaurantId: string, panel: Panel) => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('member_announcements', {
    p_restaurant_id: restaurantId,
    p_panel: panel,
  });
  if (error) {
    console.error('[announcements] could not load banners', error.message);
    return [];
  }
  return parseBanners(data);
});

/** Restaurants' cities as entered, for choosing an audience. */
export async function listCities() {
  const supabase = await createClient();
  const { data, error } = await supabase.from('restaurants').select('city').not('city', 'is', null);
  if (error) throw new Error(`Could not load the cities: ${error.message}`);
  return [
    ...new Set(data.map((row) => row.city?.trim()).filter((city) => !!city)),
  ].sort() as string[];
}

/** Every announcement, live and scheduled first (settings.manage). */
export async function listAnnouncements() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_list_announcements');
  if (error) throw new Error(`Could not load the announcements: ${error.message}`);
  return parseAnnouncements(data);
}
