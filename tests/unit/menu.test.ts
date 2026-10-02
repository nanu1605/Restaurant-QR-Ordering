import { describe, expect, it } from 'vitest';

import {
  CUISINE_SETS,
  DEFAULT_CATEGORY_SETS,
  DEFAULT_CUISINE,
  isCuisineSet,
  missingCategories,
  normalizeCategoryName,
} from '@/features/menu/default-categories';
import {
  formatPriceInput,
  menuItemFormSchema,
  parsePriceInput,
  toMenuItemPayload,
  type MenuItemForm,
} from '@/features/menu/schemas';

describe('default category sets (spec §8.4)', () => {
  it('match the spec, in order', () => {
    expect(DEFAULT_CUISINE).toBe('north_indian');
    expect(DEFAULT_CATEGORY_SETS.north_indian).toEqual([
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
    ]);
    expect(DEFAULT_CATEGORY_SETS.south_indian).toHaveLength(11);
    expect(DEFAULT_CATEGORY_SETS.cafe).toHaveLength(11);
    expect(DEFAULT_CATEGORY_SETS.fast_food).toHaveLength(10);
    expect(DEFAULT_CATEGORY_SETS.bakery).toHaveLength(7);
    expect(DEFAULT_CATEGORY_SETS.multi_cuisine).toHaveLength(10);
    expect(DEFAULT_CATEGORY_SETS.blank).toEqual([]);
  });

  it('every set has unique names that fit the database (≤ 60 chars)', () => {
    for (const set of CUISINE_SETS) {
      const names = DEFAULT_CATEGORY_SETS[set];
      expect(new Set(names.map(normalizeCategoryName)).size).toBe(names.length);
      expect(names.every((name) => name.length <= 60)).toBe(true);
    }
  });

  it('recognises set names', () => {
    expect(isCuisineSet('cafe')).toBe(true);
    expect(isCuisineSet('thai')).toBe(false);
    expect(isCuisineSet(undefined)).toBe(false);
  });

  it('suggests only missing names, ignoring case and spacing', () => {
    expect(missingCategories('bakery', ['cakes', '  Pastries ', 'Cookies  &  Biscuits'])).toEqual([
      'Breads & Buns',
      'Savouries',
      'Snacks',
      'Beverages',
    ]);
    expect(missingCategories('blank', ['Anything'])).toEqual([]);
  });
});

describe('price input', () => {
  it('parses rupees into paise', () => {
    expect(parsePriceInput('280')).toBe(28000);
    expect(parsePriceInput('280.5')).toBe(28050);
    expect(parsePriceInput(' ₹1,250.75 ')).toBe(125075);
    expect(parsePriceInput('0')).toBe(0);
  });

  it('rejects anything else, and prices above ₹10,00,000', () => {
    expect(parsePriceInput('')).toBeNull();
    expect(parsePriceInput('12.345')).toBeNull();
    expect(parsePriceInput('-5')).toBeNull();
    expect(parsePriceInput('abc')).toBeNull();
    expect(parsePriceInput('1000000')).toBe(100_000_000);
    expect(parsePriceInput('1000000.01')).toBeNull();
  });

  it('formats paise back for editing', () => {
    expect(formatPriceInput(28000)).toBe('280');
    expect(formatPriceInput(28050)).toBe('280.50');
    expect(formatPriceInput(5)).toBe('0.05');
  });
});

describe('menu item form', () => {
  const base: MenuItemForm = {
    id: '11111111-1111-4111-8111-111111111111',
    categoryId: '22222222-2222-4222-8222-222222222222',
    name: ' Paneer Tikka ',
    nameHi: '',
    description: '',
    foodType: 'veg',
    hasVariants: false,
    price: '280',
    variants: [],
    addonGroupIds: [],
    isAvailable: true,
  };

  it('needs a price without options', () => {
    const result = menuItemFormSchema.safeParse({ ...base, price: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['price']);
  });

  it('needs at least one option, each with its own name', () => {
    const none = menuItemFormSchema.safeParse({ ...base, hasVariants: true });
    expect(none.error?.issues[0]).toMatchObject({
      path: ['variants'],
      message: 'Add at least one option.',
    });

    const duplicate = menuItemFormSchema.safeParse({
      ...base,
      hasVariants: true,
      variants: [
        { name: 'Half', price: '220' },
        { name: ' half ', price: '380' },
      ],
    });
    expect(duplicate.error?.issues[0]).toMatchObject({
      path: ['variants', 1, 'name'],
      message: 'Each option needs its own name.',
    });
  });

  it('converts to the database payload in paise', () => {
    const parsed = menuItemFormSchema.parse({
      ...base,
      hasVariants: true,
      variants: [
        { variantId: '33333333-3333-4333-8333-333333333333', name: 'Full', price: '380' },
        { name: 'Half', price: '220.50' },
      ],
    });
    expect(toMenuItemPayload(parsed)).toEqual({
      id: base.id,
      category_id: base.categoryId,
      name: 'Paneer Tikka',
      name_hi: null,
      description: null,
      food_type: 'veg',
      price_paise: 22050,
      is_available: true,
      variants: [
        { id: '33333333-3333-4333-8333-333333333333', name: 'Full', price_paise: 38000 },
        { name: 'Half', price_paise: 22050 },
      ],
      addon_group_ids: [],
    });

    expect(toMenuItemPayload(menuItemFormSchema.parse(base))).toMatchObject({
      price_paise: 28000,
      variants: [],
    });
  });

  it('keeps an optional Hindi name, trimmed, and clears an empty one', () => {
    const named = menuItemFormSchema.parse({ ...base, nameHi: ' पनीर टिक्का ' });
    expect(toMenuItemPayload(named).name_hi).toBe('पनीर टिक्का');
    expect(toMenuItemPayload(menuItemFormSchema.parse(base)).name_hi).toBeNull();

    const tooLong = menuItemFormSchema.safeParse({ ...base, nameHi: 'क'.repeat(81) });
    expect(tooLong.error?.issues[0]).toMatchObject({
      path: ['nameHi'],
      message: 'Use 80 characters or fewer.',
    });
  });
});
