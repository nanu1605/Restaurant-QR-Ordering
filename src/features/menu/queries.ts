import 'server-only';

import type { CustomerAddonGroup } from '@/features/ordering/types';
import { createClient } from '@/lib/supabase/server';

import type { FoodType } from './schemas';

export type AdminCategory = {
  id: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
};

export type AdminVariant = {
  id: string;
  name: string;
  pricePaise: number;
};

export type AdminMenuItem = {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  pricePaise: number;
  foodType: FoodType;
  imagePath: string | null;
  /** Changes whenever the row changes; used to refresh cached images. */
  updatedAt: string;
  isAvailable: boolean;
  isActive: boolean;
  sortOrder: number;
  /** Active variants in display order (removed ones are kept only for history). */
  variants: AdminVariant[];
  addonGroupIds: string[];
};

/** A shared add-on group with its options, oldest first (docs/DECISIONS.md P9-4). */
export type AdminAddonGroup = CustomerAddonGroup;

export type AdminMenu = {
  categories: AdminCategory[];
  items: AdminMenuItem[];
  addonGroups: AdminAddonGroup[];
};

/** Every category and dish of the signed-in member's restaurant (RLS-scoped). */
export async function getAdminMenu(): Promise<AdminMenu> {
  const supabase = await createClient();
  const [categories, items, groups] = await Promise.all([
    supabase
      .from('menu_categories')
      .select('id, name, is_active, sort_order')
      .order('sort_order')
      .order('created_at'),
    supabase
      .from('menu_items')
      .select(
        'id, category_id, name, description, price_paise, food_type, image_path, updated_at, is_available, is_active, sort_order, variants:menu_item_variants (id, name, price_paise, sort_order, is_active), addon_links:menu_item_addon_groups (group_id)',
      )
      .order('sort_order')
      .order('created_at'),
    supabase
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

  return {
    categories: categories.data.map((category) => ({
      id: category.id,
      name: category.name,
      isActive: category.is_active,
      sortOrder: category.sort_order,
    })),
    items: items.data.map((item) => ({
      id: item.id,
      categoryId: item.category_id,
      name: item.name,
      description: item.description,
      pricePaise: item.price_paise,
      foodType: item.food_type,
      imagePath: item.image_path,
      updatedAt: item.updated_at,
      isAvailable: item.is_available,
      isActive: item.is_active,
      sortOrder: item.sort_order,
      variants: item.variants
        .filter((variant) => variant.is_active)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((variant) => ({
          id: variant.id,
          name: variant.name,
          pricePaise: variant.price_paise,
        })),
      addonGroupIds: item.addon_links.map((link) => link.group_id),
    })),
    addonGroups: groups.data.map((group) => ({
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
    })),
  };
}
