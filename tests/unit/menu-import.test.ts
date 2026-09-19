import { describe, expect, it } from 'vitest';

import { csvToDraft, parseCsv } from '@/features/menu-import/csv-reader';
import {
  draftCounts,
  duplicateNames,
  itemFlags,
  pageExtractionSchema,
  rupeesToImportPaise,
  type Draft,
  type DraftItem,
  type PageExtraction,
} from '@/features/menu-import/draft';
import { hiddenCategoryKeys, markExistingItems, mergePages } from '@/features/menu-import/merge';

// Menu import (spec §20A.3, docs/DECISIONS.md P7-16, P7-17).

function item(patch: Partial<DraftItem> = {}): DraftItem {
  return {
    key: 'k',
    page: 1,
    name: 'Paneer Tikka',
    description: null,
    food_type: 'veg',
    price_paise: 28000,
    variants: [],
    confidence: 'high',
    notes: null,
    reviewed: false,
    action: 'import',
    existing_item_id: null,
    ...patch,
  };
}

function page(categories: PageExtraction['categories'], notes?: string): PageExtraction {
  return { categories, page_notes: notes ?? null };
}

const dish = (
  name: string,
  price: number | null,
  patch: Partial<PageExtraction['categories'][number]['items'][number]> = {},
) => ({
  name,
  description: null,
  food_type: 'veg' as const,
  price,
  variants: [],
  confidence: 'high' as const,
  notes: null,
  ...patch,
});

describe('parseCsv', () => {
  it('reads quotes, escaped quotes, commas and line breaks inside quotes', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,"two\nlines",3')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', 'two\nlines', '3'],
    ]);
  });

  it('drops a byte order mark and handles a missing final newline or a trailing one', () => {
    expect(parseCsv(`${String.fromCharCode(0xfeff)}name\nDal`)).toEqual([['name'], ['Dal']]);
    expect(parseCsv('name\nDal\n')).toEqual([['name'], ['Dal']]);
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });
});

describe('csvToDraft', () => {
  const header = 'Category,Name,Description,Food Type,Price,Variant Name,Variant Price';

  it('groups options of a dish and keeps categories in first-seen order', () => {
    const result = csvToDraft(
      [
        header,
        'Starters,Paneer Tikka,"cottage cheese, peppers",veg,280,,',
        'Starters,Chicken 65,,non-veg,,Half,180',
        'Starters,Chicken 65,,non-veg,,Full,320',
        'Breads,Butter Naan,,,60,,',
        ' starters ,Egg Pakora,,egg,"₹1,20",,',
      ].join('\n'),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.dishes).toBe(4);
    expect(result.draft.categories.map((c) => c.name)).toEqual(['Starters', 'Breads']);
    const [tikka, chicken, pakora] = result.draft.categories[0]!.items;
    expect(tikka).toMatchObject({
      name: 'Paneer Tikka',
      description: 'cottage cheese, peppers',
      price_paise: 28000,
      food_type: 'veg',
      page: null,
    });
    expect(chicken).toMatchObject({
      food_type: 'non_veg',
      price_paise: null,
      variants: [
        { name: 'Half', price_paise: 18000 },
        { name: 'Full', price_paise: 32000 },
      ],
    });
    expect(pakora).toMatchObject({ food_type: 'egg', price_paise: 12000 });
    expect(result.draft.categories[1]!.items[0]).toMatchObject({ food_type: 'unknown' });
  });

  it('uses the price column for an option without its own price', () => {
    const result = csvToDraft(
      'category,name,price,variant_name\nMains,Dal,150,Half\nMains,Dal,250,Full',
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.draft.categories[0]!.items[0]!.variants).toEqual([
      { name: 'Half', price_paise: 15000 },
      { name: 'Full', price_paise: 25000 },
    ]);
  });

  it('lists bad rows by their spreadsheet row number', () => {
    const result = csvToDraft(
      [
        header,
        'Starters,,,,280,,',
        'Starters,Soup,,fishy,abc,,',
        'Starters,Salad,,veg,120,,',
        'Starters,Salad,,veg,130,,',
      ].join('\n'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.row)).toEqual([2, 3, 5]);
    expect(result.errors[0]!.message).toBe('Row 2: the dish name is missing.');
    expect(result.errors[1]!.message).toContain('food_type "fishy"');
    expect(result.errors[1]!.message).toContain('price "abc" is not a price');
    expect(result.errors[2]!.message).toContain('repeats the dish on row 4');
  });

  it('refuses options added to a dish that has a single price', () => {
    const result = csvToDraft(
      'category,name,price,variant_name\nMains,Dal,150,\nMains,Dal,250,Full',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.message).toContain('the dish on row 2 has no variant_name');
  });

  it('needs the category, name and a price column', () => {
    const result = csvToDraft('dish,cost\nDal,100');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.message).toBe(
      'The first row must name the columns. Missing: category, name, price.',
    );
  });

  it('refuses more than 500 dishes and shows at most 20 errors', () => {
    const many = [
      'category,name,price',
      ...Array.from({ length: 501 }, (_, i) => `Mains,Dish ${i},100`),
    ];
    const tooMany = csvToDraft(many.join('\n'));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.errors[0]!.message).toContain('at most 500');

    const bad = ['category,name,price', ...Array.from({ length: 25 }, () => 'Mains,,100')];
    const errors = csvToDraft(bad.join('\n'));
    expect(errors.ok).toBe(false);
    if (!errors.ok) {
      expect(errors.errors).toHaveLength(20);
      expect(errors.moreErrors).toBe(5);
    }
  });

  it('refuses an empty file and a file over 1 MB', () => {
    expect(csvToDraft(' \n \n').ok).toBe(false);
    expect(csvToDraft(`category,name,price\n${'x'.repeat(1024 * 1024)}`).ok).toBe(false);
  });
});

describe('pageExtractionSchema', () => {
  it('accepts the shape the prompt asks for and rejects anything else', () => {
    expect(
      pageExtractionSchema.safeParse(
        page([{ name: 'Starters', confidence: 'high', items: [dish('Dal', 120)] }], 'cut off'),
      ).success,
    ).toBe(true);
    expect(
      pageExtractionSchema.safeParse({ categories: [{ name: 'X', items: [{}] }] }).success,
    ).toBe(false);
    expect(pageExtractionSchema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('mergePages', () => {
  it('merges categories across pages, drops repeats and converts rupees to paise', () => {
    const draft = mergePages([
      {
        page: 2,
        extraction: page([
          { name: 'STARTERS ', items: [dish('Paneer Tikka', 280), dish('Hara Kebab', 220.5)] },
        ]),
      },
      {
        page: 1,
        extraction: page(
          [
            { name: 'Starters', items: [dish('Paneer  Tikka', 280)] },
            { name: '', items: [dish('Water', 20)] },
          ],
          'bottom cut off',
        ),
      },
    ]);
    expect(draft.categories.map((c) => c.name)).toEqual(['Starters', 'Uncategorised']);
    expect(draft.categories[0]!.items.map((i) => [i.name, i.price_paise, i.page])).toEqual([
      ['Paneer Tikka', 28000, 1],
      ['Hara Kebab', 22050, 2],
    ]);
    expect(draft.page_notes).toEqual([{ page: 1, notes: 'bottom cut off' }]);
  });

  it('uses options instead of a single price and keeps a missing price missing', () => {
    const draft = mergePages([
      {
        page: 1,
        extraction: page([
          {
            name: 'Tandoor',
            confidence: 'low',
            items: [
              dish('Chicken Tikka', 300, {
                variants: [
                  { name: 'Half', price: 180 },
                  { name: 'Full', price: null },
                ],
              }),
              dish('Roti', null, { confidence: 'medium' }),
            ],
          },
        ]),
      },
    ]);
    const [tikka, roti] = draft.categories[0]!.items;
    expect(tikka).toMatchObject({
      price_paise: null,
      variants: [
        { name: 'Half', price_paise: 18000 },
        { name: 'Full', price_paise: null },
      ],
      confidence: 'low',
    });
    expect(roti).toMatchObject({ price_paise: null, confidence: 'low' });
  });
});

describe('itemFlags', () => {
  const none = new Set<string>();

  it('flags each rule of §20A.3', () => {
    expect(itemFlags(item(), none)).toEqual([]);
    expect(itemFlags(item({ confidence: 'medium' }), none)).toEqual(['low_confidence']);
    expect(itemFlags(item({ price_paise: null }), none)).toEqual(['price_missing']);
    expect(itemFlags(item({ price_paise: 0 }), none)).toEqual(['price_range']);
    expect(itemFlags(item({ price_paise: 400 }), none)).toEqual(['price_range']);
    expect(itemFlags(item({ price_paise: 500_100 }), none)).toEqual(['price_range']);
    expect(itemFlags(item({ food_type: 'unknown' }), none)).toEqual(['food_type_unknown']);
    expect(itemFlags(item({ name: 'Ab' }), none)).toEqual(['name_length']);
    expect(itemFlags(item({ name: 'x'.repeat(81) }), none)).toEqual(['name_invalid']);
    expect(itemFlags(item(), new Set(['paneer tikka']))).toEqual(['duplicate_name']);
    expect(
      itemFlags(
        item({
          price_paise: null,
          variants: [
            { name: 'Half', price_paise: 100_00 },
            { name: ' half', price_paise: 200_00 },
          ],
        }),
        none,
      ),
    ).toEqual(['duplicate_option']);
  });

  it('drops the soft flags once the owner has looked at the row', () => {
    expect(
      itemFlags(item({ reviewed: true, confidence: 'low', price_paise: 700_000 }), none),
    ).toEqual([]);
    expect(itemFlags(item({ reviewed: true, price_paise: null }), none)).toEqual(['price_missing']);
    expect(itemFlags(item({ reviewed: true, food_type: 'unknown' }), none)).toEqual([
      'food_type_unknown',
    ]);
  });
});

describe('duplicateNames and draftCounts', () => {
  const draft: Draft = {
    version: 1,
    page_notes: [],
    categories: [
      {
        key: 'a',
        name: 'Starters',
        skip: false,
        show_hidden: false,
        items: [
          item({ key: '1' }),
          item({ key: '2', name: 'Soup', price_paise: null }),
          item({ key: '3', name: 'Kebab', food_type: 'unknown' }),
          item({ key: '4', name: 'Old', action: 'update_price', existing_item_id: 'x' }),
          item({ key: '5', name: 'Skipped', action: 'skip' }),
        ],
      },
      {
        key: 'b',
        name: 'Mains',
        skip: false,
        show_hidden: false,
        items: [item({ key: '6', name: 'paneer tikka' })],
      },
      { key: 'c', name: 'Drinks', skip: true, show_hidden: false, items: [item({ key: '7' })] },
    ],
  };

  it('finds names used in more than one category, ignoring skipped rows', () => {
    expect(duplicateNames(draft)).toEqual(new Set(['paneer tikka']));
  });

  it('counts what the commit would do', () => {
    expect(draftCounts(draft)).toEqual({
      categories: 2,
      items: 5,
      newItems: 4,
      priceUpdates: 1,
      needsCheck: 4,
      blocking: 1,
      unknownFoodType: 1,
    });
  });
});

describe('rupeesToImportPaise', () => {
  it('rounds to paise and refuses what cannot be a price', () => {
    expect(rupeesToImportPaise(280)).toBe(28000);
    expect(rupeesToImportPaise(99.999)).toBe(10000);
    expect(rupeesToImportPaise(null)).toBeNull();
    expect(rupeesToImportPaise(-5)).toBeNull();
    expect(rupeesToImportPaise(2_000_000)).toBeNull();
  });
});

describe('markExistingItems', () => {
  const menu = {
    categories: [
      {
        id: 'cat-1',
        name: 'Starters',
        isActive: true,
        items: [
          { id: 'item-1', name: 'Paneer Tikka', isActive: true, hasVariants: false },
          { id: 'item-2', name: 'Old Soup', isActive: false, hasVariants: false },
        ],
      },
      { id: 'cat-2', name: 'Desserts', isActive: false, items: [] },
    ],
  };
  const draft: Draft = {
    version: 1,
    page_notes: [],
    categories: [
      {
        key: 'a',
        name: 'starters',
        skip: false,
        show_hidden: false,
        items: [
          item({ key: '1', name: 'PANEER TIKKA' }),
          item({ key: '2', name: 'Old Soup' }),
          item({ key: '3', name: 'Kebab', action: 'update_price', existing_item_id: 'gone' }),
        ],
      },
      { key: 'b', name: 'Desserts', skip: false, show_hidden: false, items: [item({ key: '4' })] },
    ],
  };

  it('skips dishes already in the same category and forgets matches that are gone', () => {
    const [tikka, soup, kebab] = markExistingItems(draft, menu).categories[0]!.items;
    expect(tikka).toMatchObject({ existing_item_id: 'item-1', action: 'skip' });
    expect(soup).toMatchObject({ existing_item_id: null, action: 'import' });
    expect(kebab).toMatchObject({ existing_item_id: null, action: 'import' });
  });

  it('keeps the owner’s choice for a match that still exists', () => {
    const chosen = markExistingItems(draft, menu);
    chosen.categories[0]!.items[0]!.action = 'update_price';
    expect(markExistingItems(chosen, menu).categories[0]!.items[0]!.action).toBe('update_price');
  });

  it('finds categories that match hidden ones', () => {
    expect(hiddenCategoryKeys(draft, menu)).toEqual(new Set(['b']));
  });
});
