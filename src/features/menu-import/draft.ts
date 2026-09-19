import { z } from 'zod';

import { normalizeCategoryName } from '@/features/menu/default-categories';
import { MAX_PRICE_PAISE } from '@/features/menu/schemas';

/**
 * The menu import draft (spec §20A.3–20A.4, docs/DECISIONS.md P7-17): what a
 * photo or CSV import produces and the owner edits before the commit. Prices
 * are paise. The database checks everything again on commit (P7-18).
 */

export const MAX_IMPORT_PAGES = 10;
export const MAX_IMPORT_ITEMS = 500;
export const MAX_VARIANTS = 20;

export const IMPORT_FOOD_TYPES = ['veg', 'non_veg', 'egg', 'unknown'] as const;
export type ImportFoodType = (typeof IMPORT_FOOD_TYPES)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const ITEM_ACTIONS = ['import', 'skip', 'update_price'] as const;
export type ItemAction = (typeof ITEM_ACTIONS)[number];

// ─── What the model returns for one page (§20A.2), prices in rupees ─────────
export const pageExtractionSchema = z.object({
  categories: z
    .array(
      z.object({
        name: z.string().max(200),
        confidence: z.enum(CONFIDENCE_LEVELS).nullish(),
        items: z
          .array(
            z.object({
              name: z.string().max(300),
              description: z.string().max(2000).nullish(),
              food_type: z.enum(IMPORT_FOOD_TYPES),
              price: z.number().nonnegative().nullable(),
              variants: z
                .array(
                  z.object({
                    name: z.string().max(200),
                    price: z.number().nonnegative().nullable(),
                  }),
                )
                .max(50),
              confidence: z.enum(CONFIDENCE_LEVELS),
              notes: z.string().max(1000).nullish(),
            }),
          )
          .max(400),
      }),
    )
    .max(100),
  page_notes: z.string().max(2000).nullish(),
});
export type PageExtraction = z.infer<typeof pageExtractionSchema>;

// ─── The draft ──────────────────────────────────────────────────────────────
export const draftVariantSchema = z.object({
  name: z.string(),
  price_paise: z.number().int().nonnegative().nullable(),
});
export type DraftVariant = z.infer<typeof draftVariantSchema>;

export const draftItemSchema = z.object({
  key: z.string(),
  /** Page the row was read from (photo imports); null for CSV. */
  page: z.number().int().positive().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  food_type: z.enum(IMPORT_FOOD_TYPES),
  price_paise: z.number().int().nonnegative().nullable(),
  variants: z.array(draftVariantSchema),
  confidence: z.enum(CONFIDENCE_LEVELS),
  notes: z.string().nullable(),
  /** The owner looked at the row (edited it or said it looks right). */
  reviewed: z.boolean(),
  action: z.enum(ITEM_ACTIONS),
  /** The dish already on the menu with this name, when there is one. */
  existing_item_id: z.string().nullable(),
});
export type DraftItem = z.infer<typeof draftItemSchema>;

export const draftCategorySchema = z.object({
  key: z.string(),
  name: z.string(),
  skip: z.boolean(),
  /** Bring back a matched hidden category (P7-18). */
  show_hidden: z.boolean(),
  items: z.array(draftItemSchema),
});
export type DraftCategory = z.infer<typeof draftCategorySchema>;

export const draftSchema = z.object({
  version: z.literal(1),
  categories: z.array(draftCategorySchema),
  /** Page notes from the model, e.g. "bottom of page cut off". */
  page_notes: z.array(z.object({ page: z.number().int().positive(), notes: z.string() })),
});
export type Draft = z.infer<typeof draftSchema>;

// ─── Flags (§20A.3) ─────────────────────────────────────────────────────────
/** Soft flags go away once the owner has looked at the row; hard ones need a fix. */
export const ITEM_FLAGS = {
  price_missing: { label: 'Price missing', hard: true },
  food_type_unknown: { label: 'Veg/non-veg not detected', hard: true },
  duplicate_option: { label: 'Two options have the same name', hard: true },
  name_invalid: { label: 'Name missing or too long', hard: true },
  low_confidence: { label: 'Not sure this was read right', hard: false },
  already_in_menu: { label: 'Already on the menu', hard: false },
  price_range: { label: 'Price looks unusual', hard: false },
  name_length: { label: 'Name looks too short', hard: false },
  duplicate_name: { label: 'Same name in another category', hard: false },
} as const;
export type ItemFlag = keyof typeof ITEM_FLAGS;

const MIN_USUAL_PAISE = 500; // ₹5
const MAX_USUAL_PAISE = 500_000; // ₹5,000

export function normalizeItemName(name: string): string {
  return normalizeCategoryName(name);
}

/** Names that appear in more than one category (compared case- and spacing-insensitively). */
export function duplicateNames(draft: Pick<Draft, 'categories'>): Set<string> {
  const seen = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const category of draft.categories) {
    if (category.skip) continue;
    for (const item of category.items) {
      if (item.action === 'skip') continue;
      const name = normalizeItemName(item.name);
      const other = seen.get(name);
      if (other !== undefined && other !== category.key) duplicates.add(name);
      else seen.set(name, category.key);
    }
  }
  return duplicates;
}

function unusualPrice(paise: number): boolean {
  return paise < MIN_USUAL_PAISE || paise > MAX_USUAL_PAISE;
}

/**
 * Why a row needs a check, worked out from its current values.
 * `alreadyInMenu` is the live match against the menu, which changes as the
 * owner edits a name or moves a row (spec §20A.4).
 */
export function itemFlags(
  item: DraftItem,
  duplicates: ReadonlySet<string>,
  alreadyInMenu = false,
): ItemFlag[] {
  const flags: ItemFlag[] = [];
  const name = item.name.trim();
  const prices =
    item.variants.length > 0
      ? item.variants.map((variant) => variant.price_paise)
      : [item.price_paise];

  if (name.length === 0 || name.length > 80) flags.push('name_invalid');
  if (prices.some((price) => price === null)) flags.push('price_missing');
  if (item.food_type === 'unknown') flags.push('food_type_unknown');
  const optionNames = item.variants.map((variant) => normalizeItemName(variant.name));
  if (new Set(optionNames).size !== optionNames.length) flags.push('duplicate_option');

  if (!item.reviewed) {
    if (item.confidence !== 'high') flags.push('low_confidence');
    if (prices.some((price) => price !== null && (price === 0 || unusualPrice(price)))) {
      flags.push('price_range');
    }
    if (name.length > 0 && name.length < 3) flags.push('name_length');
    if (duplicates.has(normalizeItemName(item.name))) flags.push('duplicate_name');
    if (alreadyInMenu && item.action === 'import') flags.push('already_in_menu');
  }
  return flags;
}

/** A row that will be written by the commit. */
export function isIncluded(category: DraftCategory, item: DraftItem): boolean {
  return !category.skip && item.action !== 'skip';
}

export type DraftCounts = {
  categories: number;
  items: number;
  newItems: number;
  priceUpdates: number;
  needsCheck: number;
  /** Rows that block the import until fixed or skipped. */
  blocking: number;
  unknownFoodType: number;
};

export function draftCounts(
  draft: Pick<Draft, 'categories'>,
  alreadyInMenu: ReadonlySet<string> = new Set(),
): DraftCounts {
  const duplicates = duplicateNames(draft);
  const counts: DraftCounts = {
    categories: 0,
    items: 0,
    newItems: 0,
    priceUpdates: 0,
    needsCheck: 0,
    blocking: 0,
    unknownFoodType: 0,
  };
  for (const category of draft.categories) {
    let included = false;
    for (const item of category.items) {
      if (!isIncluded(category, item)) continue;
      const flags = itemFlags(item, duplicates, alreadyInMenu.has(item.key));
      counts.items += 1;
      if (item.action === 'update_price') counts.priceUpdates += 1;
      else {
        counts.newItems += 1;
        included = true;
        if (item.food_type === 'unknown') counts.unknownFoodType += 1;
      }
      if (flags.length > 0) counts.needsCheck += 1;
      if (flags.some((flag) => ITEM_FLAGS[flag].hard && flag !== 'food_type_unknown')) {
        counts.blocking += 1;
      }
    }
    if (included) counts.categories += 1;
  }
  return counts;
}

// ─── Building rows ──────────────────────────────────────────────────────────
/** Model rupees → paise; null for a missing price or one out of range. */
export function rupeesToImportPaise(rupees: number | null | undefined): number | null {
  if (rupees === null || rupees === undefined || !Number.isFinite(rupees) || rupees < 0) {
    return null;
  }
  const paise = Math.round(rupees * 100);
  return paise <= MAX_PRICE_PAISE ? paise : null;
}

export function tidyText(text: string | null | undefined): string {
  return (text ?? '').trim().replace(/\s+/g, ' ');
}

export function emptyDraft(): Draft {
  return { version: 1, categories: [], page_notes: [] };
}

/** The rows the commit function takes (the review-only keys go along and are ignored). */
export function commitPayload(draft: Draft): Draft {
  return {
    ...draft,
    categories: draft.categories.map((category) => ({
      ...category,
      name: tidyText(category.name),
      items: category.items.map((item) => ({
        ...item,
        name: tidyText(item.name),
        description: tidyText(item.description) || null,
        variants: item.variants.map((variant) => ({ ...variant, name: tidyText(variant.name) })),
      })),
    })),
  };
}
