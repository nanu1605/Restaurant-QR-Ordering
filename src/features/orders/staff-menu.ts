import type { SupabaseClient } from '@supabase/supabase-js';

import { localName } from '@/features/ordering/localize';
import type { Lang } from '@/features/ordering/strings';
import type {
  CustomerAddonGroup,
  CustomerCategory,
  CustomerMenuItem,
} from '@/features/ordering/types';
import type { Database } from '@/types/database';

/**
 * The menu as staff pick from it ("Add dishes") and switch stock on the
 * Availability page (spec §13.2): active categories that have active dishes,
 * out-of-stock dishes flagged rather than hidden, active options in order,
 * and each dish's add-on groups. Same shape as the customer menu, so the same
 * search, cart and options sheet work here; isAvailable is the dish's own
 * switch. RLS lets every member read the menu. A worker panel in Hindi shows
 * dishes and categories by their Hindi name (the owner's, else the automatic
 * one), and finds them by either name (docs/DECISIONS.md P11-16).
 */
export async function fetchStaffMenu(
  client: SupabaseClient<Database>,
  lang: Lang = 'en',
): Promise<CustomerCategory[]> {
  const [categories, items, groups] = await Promise.all([
    client
      .from('menu_categories')
      .select('id, name, name_hi, name_hi_auto')
      .eq('is_active', true)
      .order('sort_order')
      .order('created_at'),
    client
      .from('menu_items')
      .select(
        'id, category_id, name, name_hi, name_hi_auto, description, price_paise, food_type, is_available, variants:menu_item_variants (id, name, price_paise, sort_order, is_active), addon_links:menu_item_addon_groups (group_id)',
      )
      .eq('is_active', true)
      .order('sort_order')
      .order('created_at'),
    client
      .from('menu_addon_groups')
      .select(
        'id, name, min_select, max_select, addons:menu_addons (id, name, price_paise, is_available, sort_order)',
      )
      .order('created_at')
      .order('id'),
  ]);
  if (categories.error) throw new Error(`Could not load categories: ${categories.error.message}`);
  if (items.error) throw new Error(`Could not load menu items: ${items.error.message}`);
  if (groups.error) throw new Error(`Could not load add-ons: ${groups.error.message}`);

  const addonGroups: CustomerAddonGroup[] = groups.data.map((group) => ({
    id: group.id,
    name: group.name,
    minSelect: group.min_select,
    maxSelect: group.max_select,
    addons: group.addons
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((addon) => ({
        id: addon.id,
        name: addon.name,
        pricePaise: addon.price_paise,
        isAvailable: addon.is_available,
      })),
  }));

  const byCategory = new Map<string, CustomerMenuItem[]>();
  for (const item of items.data) {
    const list = byCategory.get(item.category_id) ?? [];
    list.push({
      id: item.id,
      ...localName(item.name, item.name_hi ?? item.name_hi_auto, lang),
      description: item.description,
      foodType: item.food_type,
      pricePaise: item.price_paise,
      imageUrl: null,
      isAvailable: item.is_available,
      variants: item.variants
        .filter((variant) => variant.is_active)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((variant) => ({
          id: variant.id,
          name: variant.name,
          pricePaise: variant.price_paise,
        })),
      addonGroups: addonGroups.filter((group) =>
        item.addon_links.some((link) => link.group_id === group.id),
      ),
    });
    byCategory.set(item.category_id, list);
  }

  return categories.data
    .map((category) => ({
      id: category.id,
      ...localName(category.name, category.name_hi ?? category.name_hi_auto, lang),
      items: byCategory.get(category.id) ?? [],
    }))
    .filter((category) => category.items.length > 0);
}
