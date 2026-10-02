import { z } from 'zod';

import { rupeesToPaise, type Paise } from '@/lib/money';
import { Constants } from '@/types/database';

import { normalizeCategoryName } from './default-categories';

/** Shared by the Menu page forms and the server actions (spec §4, §13.3). */

export const FOOD_TYPES = Constants.public.Enums.food_type;
export type FoodType = (typeof FOOD_TYPES)[number];

/** Highest price accepted for one dish or option (matches the database). */
export const MAX_PRICE_PAISE = 100_000_000; // ₹10,00,000

/** "₹1,250.50" / "1250.5" / " 60 " → paise; null when it isn't a valid price. */
export function parsePriceInput(text: string): Paise | null {
  const cleaned = text.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const paise = rupeesToPaise(cleaned);
  return paise <= MAX_PRICE_PAISE ? paise : null;
}

/** Paise → the text shown in a price input: 28000 → "280", 28050 → "280.50". */
export function formatPriceInput(paise: Paise): string {
  const rupees = Math.trunc(paise / 100);
  const fraction = paise % 100;
  return fraction === 0 ? String(rupees) : `${rupees}.${String(fraction).padStart(2, '0')}`;
}

const priceField = z
  .string()
  .refine((value) => value.trim() !== '', 'Enter a price.')
  .refine(
    (value) => value.trim() === '' || parsePriceInput(value) !== null,
    'Enter a price in rupees, e.g. 280 or 280.50.',
  );

export const categoryNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a category name.')
  .max(60, 'Use 60 characters or fewer.');

/** Optional Hindi names, shown on the Hindi customer menu; empty clears them. */
export const categoryHindiNameSchema = z.string().trim().max(60, 'Use 60 characters or fewer.');

export const menuItemFormSchema = z
  .object({
    /** Picked by the browser for new dishes so the image can be stored under it. */
    id: z.uuid(),
    categoryId: z.uuid({ message: 'Choose a category.' }),
    name: z.string().trim().min(1, 'Enter a dish name.').max(80, 'Use 80 characters or fewer.'),
    nameHi: z.string().trim().max(80, 'Use 80 characters or fewer.'),
    description: z.string().trim().max(300, 'Use 300 characters or fewer.'),
    foodType: z.enum(FOOD_TYPES, { message: 'Choose veg, non-veg or egg.' }),
    hasVariants: z.boolean(),
    price: z.string(),
    // variantId, not id: react-hook-form's field arrays use `id` for their own keys.
    variants: z
      .array(
        z.object({
          variantId: z.uuid().optional(),
          name: z
            .string()
            .trim()
            .min(1, 'Name this option.')
            .max(40, 'Use 40 characters or fewer.'),
          price: priceField,
        }),
      )
      .max(20, 'Use 20 options or fewer.'),
    addonGroupIds: z.array(z.uuid()).max(10, 'Choose up to 10 add-on groups.'),
    isAvailable: z.boolean(),
  })
  .superRefine((item, ctx) => {
    if (!item.hasVariants) {
      if (item.price.trim() === '') {
        ctx.addIssue({ code: 'custom', path: ['price'], message: 'Enter a price.' });
      } else if (parsePriceInput(item.price) === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['price'],
          message: 'Enter a price in rupees, e.g. 280 or 280.50.',
        });
      }
      return;
    }
    if (item.variants.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['variants'], message: 'Add at least one option.' });
    }
    const seen = new Set<string>();
    item.variants.forEach((variant, index) => {
      const key = normalizeCategoryName(variant.name);
      if (key && seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', index, 'name'],
          message: 'Each option needs its own name.',
        });
      }
      seen.add(key);
    });
  });

export type MenuItemForm = z.input<typeof menuItemFormSchema>;

/** What admin_save_menu_item receives (money in paise). */
export const menuItemPayloadSchema = z.object({
  id: z.uuid(),
  category_id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  name_hi: z.string().trim().min(1).max(80).nullable(),
  description: z.string().trim().max(300).nullable(),
  food_type: z.enum(FOOD_TYPES),
  price_paise: z.number().int().min(0).max(MAX_PRICE_PAISE),
  is_available: z.boolean(),
  variants: z
    .array(
      z.object({
        id: z.uuid().optional(),
        name: z.string().trim().min(1).max(40),
        price_paise: z.number().int().min(0).max(MAX_PRICE_PAISE),
      }),
    )
    .max(20),
  addon_group_ids: z.array(z.uuid()).max(10),
});

export type MenuItemPayload = z.infer<typeof menuItemPayloadSchema>;

/** Converts a valid form into the database payload. */
export function toMenuItemPayload(form: z.output<typeof menuItemFormSchema>): MenuItemPayload {
  const variants = form.hasVariants
    ? form.variants.map((variant) => ({
        ...(variant.variantId ? { id: variant.variantId } : {}),
        name: variant.name,
        price_paise: parsePriceInput(variant.price) ?? 0,
      }))
    : [];
  return {
    id: form.id,
    category_id: form.categoryId,
    name: form.name,
    name_hi: form.nameHi === '' ? null : form.nameHi,
    description: form.description === '' ? null : form.description,
    food_type: form.foodType,
    price_paise: form.hasVariants
      ? Math.min(...variants.map((variant) => variant.price_paise))
      : (parsePriceInput(form.price) ?? 0),
    is_available: form.isAvailable,
    variants,
    addon_group_ids: form.addonGroupIds,
  };
}

// ─── Add-on groups (docs/DECISIONS.md P9-4) ─────────────────────────────────

const choiceCount = (label: string) =>
  z
    .number({ message: `Enter the ${label} number of choices.` })
    .int()
    .min(0)
    .max(20);

export const addonGroupFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a group name.').max(60, 'Use 60 characters or fewer.'),
    minSelect: choiceCount('smallest'),
    maxSelect: choiceCount('largest').min(1, 'Allow at least 1 choice.'),
    // addonId, not id: react-hook-form's field arrays use `id` for their own keys.
    addons: z
      .array(
        z.object({
          addonId: z.uuid().optional(),
          name: z
            .string()
            .trim()
            .min(1, 'Name this add-on.')
            .max(40, 'Use 40 characters or fewer.'),
          price: priceField,
        }),
      )
      .min(1, 'Add at least one add-on.')
      .max(30, 'Use 30 add-ons or fewer.'),
  })
  .superRefine((group, ctx) => {
    if (group.minSelect > group.maxSelect) {
      ctx.addIssue({
        code: 'custom',
        path: ['minSelect'],
        message: 'The smallest number can’t be more than the largest.',
      });
    } else if (group.minSelect > group.addons.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['minSelect'],
        message: 'Customers can’t choose more add-ons than the group has.',
      });
    }
    const seen = new Set<string>();
    group.addons.forEach((addon, index) => {
      const key = normalizeCategoryName(addon.name);
      if (key && seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['addons', index, 'name'],
          message: 'Each add-on needs its own name.',
        });
      }
      seen.add(key);
    });
  });

export type AddonGroupForm = z.input<typeof addonGroupFormSchema>;

/** What admin_save_addon_group receives (money in paise). */
export const addonGroupPayloadSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(60),
  min_select: z.number().int().min(0).max(20),
  max_select: z.number().int().min(1).max(20),
  addons: z
    .array(
      z.object({
        id: z.uuid().optional(),
        name: z.string().trim().min(1).max(40),
        price_paise: z.number().int().min(0).max(MAX_PRICE_PAISE),
      }),
    )
    .min(1)
    .max(30),
});

export type AddonGroupPayload = z.infer<typeof addonGroupPayloadSchema>;

export function toAddonGroupPayload(
  id: string | null,
  form: z.output<typeof addonGroupFormSchema>,
): AddonGroupPayload {
  return {
    ...(id ? { id } : {}),
    name: form.name,
    min_select: form.minSelect,
    max_select: form.maxSelect,
    addons: form.addons.map((addon) => ({
      ...(addon.addonId ? { id: addon.addonId } : {}),
      name: addon.name,
      price_paise: parsePriceInput(addon.price) ?? 0,
    })),
  };
}

/** Image files accepted after compression (spec §4: ≤ 800 px WebP, bucket limit 1 MB). */
export const MENU_IMAGE_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;
export const MAX_IMAGE_BYTES = 1024 * 1024;

export function imageExtension(type: string): string | null {
  switch (type) {
    case 'image/webp':
      return 'webp';
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    default:
      return null;
  }
}
