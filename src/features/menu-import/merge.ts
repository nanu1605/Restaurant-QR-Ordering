import { normalizeCategoryName } from '@/features/menu/default-categories';

import {
  emptyDraft,
  normalizeItemName,
  rupeesToImportPaise,
  tidyText,
  type Confidence,
  type Draft,
  type DraftCategory,
  type DraftItem,
  type PageExtraction,
} from './draft';

/**
 * Pages → one draft (spec §20A.3): categories in page order, merged when
 * their names match ignoring case and spacing; exact repeats (same name and
 * prices) dropped within a category, since menus repeat headers across pages.
 */

const UNCATEGORISED = 'Uncategorised';
const CONFIDENCE_RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };

function lower(a: Confidence, b: Confidence | null | undefined): Confidence {
  if (!b) return a;
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

function sameRow(a: DraftItem, b: DraftItem): boolean {
  return (
    normalizeItemName(a.name) === normalizeItemName(b.name) &&
    a.price_paise === b.price_paise &&
    a.variants.length === b.variants.length &&
    a.variants.every(
      (variant, index) =>
        normalizeItemName(variant.name) === normalizeItemName(b.variants[index]!.name) &&
        variant.price_paise === b.variants[index]!.price_paise,
    )
  );
}

type ExtractedItem = PageExtraction['categories'][number]['items'][number];

function toDraftItem(
  item: ExtractedItem,
  page: number,
  key: string,
  categoryConfidence: Confidence | null | undefined,
): DraftItem {
  const variants = item.variants.map((variant) => ({
    name: tidyText(variant.name).slice(0, 40),
    price_paise: rupeesToImportPaise(variant.price),
  }));
  return {
    key,
    page,
    name: tidyText(item.name),
    description: tidyText(item.description).slice(0, 300) || null,
    food_type: item.food_type,
    // With options, the option prices are the prices (§8.4).
    price_paise: variants.length > 0 ? null : rupeesToImportPaise(item.price),
    variants,
    confidence: lower(item.confidence, categoryConfidence),
    notes: tidyText(item.notes) || null,
    reviewed: false,
    action: 'import',
    existing_item_id: null,
  };
}

export function mergePages(
  pages: ReadonlyArray<{ page: number; extraction: PageExtraction }>,
): Draft {
  const draft = emptyDraft();
  const byName = new Map<string, DraftCategory>();

  for (const { page, extraction } of [...pages].sort((a, b) => a.page - b.page)) {
    const notes = tidyText(extraction.page_notes);
    if (notes) draft.page_notes.push({ page, notes });

    extraction.categories.forEach((category, categoryIndex) => {
      const name = tidyText(category.name).slice(0, 60) || UNCATEGORISED;
      const nameKey = normalizeCategoryName(name);
      let target = byName.get(nameKey);
      if (!target) {
        target = {
          key: `c${byName.size + 1}`,
          name,
          skip: false,
          show_hidden: false,
          items: [],
        };
        byName.set(nameKey, target);
        draft.categories.push(target);
      }

      category.items.forEach((item, itemIndex) => {
        const row = toDraftItem(
          item,
          page,
          `p${page}-${categoryIndex + 1}-${itemIndex + 1}`,
          category.confidence,
        );
        if (!row.name && row.price_paise === null && row.variants.length === 0) return;
        if (target.items.some((existing) => sameRow(existing, row))) return;
        target.items.push(row);
      });
    });
  }

  draft.categories = draft.categories.filter((category) => category.items.length > 0);
  return draft;
}

// ─── The current menu (§20A.4 "Already in menu") ────────────────────────────
export type CurrentMenu = {
  categories: Array<{
    id: string;
    name: string;
    isActive: boolean;
    items: Array<{ id: string; name: string; isActive: boolean; hasVariants: boolean }>;
  }>;
};

/**
 * Marks rows whose name matches an active dish in the same category as
 * already in the menu, skipped by default (the owner can switch to "Update
 * price"). Worked out again each time the review opens, since the menu may
 * have changed; a match that no longer exists goes back to a new dish.
 */
export function markExistingItems(draft: Draft, menu: CurrentMenu): Draft {
  const categories = new Map(menu.categories.map((c) => [normalizeCategoryName(c.name), c]));
  const activeIds = new Set(
    menu.categories.flatMap((c) => c.items.filter((i) => i.isActive).map((i) => i.id)),
  );

  return {
    ...draft,
    categories: draft.categories.map((category) => {
      const existing = categories.get(normalizeCategoryName(category.name));
      return {
        ...category,
        items: category.items.map((item) => {
          if (item.existing_item_id && activeIds.has(item.existing_item_id)) return item;
          const match = existing?.items.find(
            (dish) =>
              dish.isActive && normalizeItemName(dish.name) === normalizeItemName(item.name),
          );
          if (match) {
            return {
              ...item,
              existing_item_id: match.id,
              action: item.action === 'import' ? 'skip' : item.action,
            };
          }
          return {
            ...item,
            existing_item_id: null,
            action: item.action === 'update_price' ? 'import' : item.action,
          };
        }),
      };
    }),
  };
}

/** The menu as the review screen needs it: dish names per category name. */
export type MenuIndex = Array<{
  name: string;
  isActive: boolean;
  items: Array<{ id: string; name: string; hasVariants: boolean }>;
}>;

export function menuIndex(menu: CurrentMenu): MenuIndex {
  return menu.categories.map((category) => ({
    name: category.name,
    isActive: category.isActive,
    items: category.items
      .filter((item) => item.isActive)
      .map((item) => ({ id: item.id, name: item.name, hasVariants: item.hasVariants })),
  }));
}

/** Draft categories that match a hidden menu category, by draft key. */
export function hiddenCategoryKeys(draft: Draft, menu: CurrentMenu): Set<string> {
  const hidden = new Set(
    menu.categories.filter((c) => !c.isActive).map((c) => normalizeCategoryName(c.name)),
  );
  return new Set(
    draft.categories
      .filter((category) => hidden.has(normalizeCategoryName(category.name)))
      .map((category) => category.key),
  );
}
