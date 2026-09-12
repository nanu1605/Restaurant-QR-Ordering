/**
 * Default category sets (spec §8.4). A new restaurant starts with the set for
 * its cuisine type, and the Menu page can add another set later, skipping
 * names that already exist. These are the only copy of the sets: onboarding
 * passes the chosen names to platform_create_restaurant.
 *
 * Imported by scripts/ through Node's TypeScript support, so keep it free of
 * path aliases and runtime dependencies.
 */

export const CUISINE_SETS = [
  'north_indian',
  'south_indian',
  'cafe',
  'fast_food',
  'bakery',
  'multi_cuisine',
  'blank',
] as const;

export type CuisineSet = (typeof CUISINE_SETS)[number];

export const DEFAULT_CUISINE: CuisineSet = 'north_indian';

export const CUISINE_LABELS: Record<CuisineSet, string> = {
  north_indian: 'North Indian',
  south_indian: 'South Indian',
  cafe: 'Café',
  fast_food: 'Fast food',
  bakery: 'Bakery',
  multi_cuisine: 'Multi-cuisine',
  blank: 'Start empty',
};

export const DEFAULT_CATEGORY_SETS: Record<CuisineSet, readonly string[]> = {
  north_indian: [
    'Starters',
    'Soups',
    'Salads',
    'Tandoori & Kebabs',
    'Main Course (Veg)',
    'Main Course (Non-veg)',
    'Rice & Biryani',
    'Breads',
    'Combos & Thali',
    'Accompaniments',
    'Desserts',
    'Beverages',
  ],
  south_indian: [
    'Breakfast',
    'Idli & Vada',
    'Dosa',
    'Uttapam',
    'Rice & Meals',
    'Curries',
    'Starters',
    'Snacks',
    'Chutneys & Sides',
    'Desserts',
    'Filter Coffee & Beverages',
  ],
  cafe: [
    'All Day Breakfast',
    'Sandwiches & Toasts',
    'Burgers & Wraps',
    'Pizza & Pasta',
    'Salads',
    'Fries & Sides',
    'Cakes & Desserts',
    'Hot Coffee',
    'Cold Coffee',
    'Shakes & Smoothies',
    'Tea & Others',
  ],
  fast_food: [
    'Burgers',
    'Pizza',
    'Rolls & Wraps',
    'Sandwiches',
    'Momos',
    'Fries & Sides',
    'Chinese',
    'Combos',
    'Desserts',
    'Beverages',
  ],
  bakery: [
    'Cakes',
    'Pastries',
    'Cookies & Biscuits',
    'Breads & Buns',
    'Savouries',
    'Snacks',
    'Beverages',
  ],
  multi_cuisine: [
    'Starters',
    'Soups',
    'Chinese',
    'North Indian',
    'South Indian',
    'Continental',
    'Rice & Noodles',
    'Breads',
    'Desserts',
    'Beverages',
  ],
  blank: [],
};

export function isCuisineSet(value: unknown): value is CuisineSet {
  return typeof value === 'string' && (CUISINE_SETS as readonly string[]).includes(value);
}

/** Comparison key: case- and spacing-insensitive, like the database index. */
export function normalizeCategoryName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Names from a set that the menu doesn't have yet, in set order. */
export function missingCategories(set: CuisineSet, existingNames: readonly string[]): string[] {
  const existing = new Set(existingNames.map(normalizeCategoryName));
  return DEFAULT_CATEGORY_SETS[set].filter((name) => !existing.has(normalizeCategoryName(name)));
}
