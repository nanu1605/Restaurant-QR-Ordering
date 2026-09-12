import type { CustomerCategory } from './types';

/**
 * Search and "Veg only" on the customer menu (spec §13.1), client-side. A search
 * matches dish names and descriptions; a matching category name keeps all its
 * dishes. Categories left empty are dropped.
 */
export function filterMenu(
  menu: CustomerCategory[],
  query: string,
  vegOnly: boolean,
): CustomerCategory[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q && !vegOnly) return menu;

  return menu
    .map((category) => {
      const categoryMatches = q !== '' && category.name.toLowerCase().includes(q);
      return {
        ...category,
        items: category.items.filter(
          (item) =>
            (!vegOnly || item.foodType === 'veg') &&
            (!q ||
              categoryMatches ||
              item.name.toLowerCase().includes(q) ||
              (item.description?.toLowerCase().includes(q) ?? false)),
        ),
      };
    })
    .filter((category) => category.items.length > 0);
}

export const categorySectionId = (categoryId: string) => `category-${categoryId}`;
