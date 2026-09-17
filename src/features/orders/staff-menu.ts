import type { SupabaseClient } from '@supabase/supabase-js';

import type { CustomerCategory, CustomerMenuItem } from '@/features/ordering/types';
import type { Database } from '@/types/database';

/**
 * The menu as staff pick from it ("Add dishes") and switch stock on the
 * Availability page (spec §13.2): active categories that have active dishes,
 * out-of-stock dishes flagged rather than hidden, active options in order.
 * Same shape as the customer menu, so the same search, cart and option sheet
 * work here. RLS lets every member read the menu.
 */
export async function fetchStaffMenu(
  client: SupabaseClient<Database>,
): Promise<CustomerCategory[]> {
  const [categories, items] = await Promise.all([
    client
      .from('menu_categories')
      .select('id, name')
      .eq('is_active', true)
      .order('sort_order')
      .order('created_at'),
    client
      .from('menu_items')
      .select(
        'id, category_id, name, description, price_paise, food_type, is_available, variants:menu_item_variants (id, name, price_paise, sort_order, is_active)',
      )
      .eq('is_active', true)
      .order('sort_order')
      .order('created_at'),
  ]);
  if (categories.error) throw new Error(`Could not load categories: ${categories.error.message}`);
  if (items.error) throw new Error(`Could not load menu items: ${items.error.message}`);

  const byCategory = new Map<string, CustomerMenuItem[]>();
  for (const item of items.data) {
    const list = byCategory.get(item.category_id) ?? [];
    list.push({
      id: item.id,
      name: item.name,
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
    });
    byCategory.set(item.category_id, list);
  }

  return categories.data
    .map((category) => ({
      id: category.id,
      name: category.name,
      items: byCategory.get(category.id) ?? [],
    }))
    .filter((category) => category.items.length > 0);
}
