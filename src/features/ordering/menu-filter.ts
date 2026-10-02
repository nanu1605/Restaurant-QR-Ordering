import type { CustomerCategory } from './types';

/**
 * Search and "Veg only" on the customer menu (spec §13.1), client-side. A search
 * matches dish names (shown or typed) and descriptions; a matching category name
 * keeps all its dishes. Categories left empty are dropped.
 */
export function filterMenu(
  menu: CustomerCategory[],
  query: string,
  vegOnly: boolean,
): CustomerCategory[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q && !vegOnly) return menu;
  const has = (text: string | null | undefined) => text?.toLowerCase().includes(q) ?? false;

  return menu
    .map((category) => {
      const categoryMatches = q !== '' && (has(category.name) || has(category.altName));
      return {
        ...category,
        items: category.items.filter(
          (item) =>
            (!vegOnly || item.foodType === 'veg') &&
            (!q || categoryMatches || has(item.name) || has(item.altName) || has(item.description)),
        ),
      };
    })
    .filter((category) => category.items.length > 0);
}

export const categorySectionId = (categoryId: string) => `category-${categoryId}`;

export function countItems(menu: CustomerCategory[]): number {
  return menu.reduce((sum, category) => sum + category.items.length, 0);
}
