'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';

import {
  actionError,
  actionOk,
  fromDbError,
  fromZodError,
  type ActionResult,
} from '@/lib/action-result';
import { getRestaurantAccess } from '@/lib/auth/access';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES, STAFF_PANEL_ROLES } from '@/lib/auth/roles';
import { dbErrorMessage, GENERIC_ERROR } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

import { CUISINE_SETS, DEFAULT_CATEGORY_SETS } from './default-categories';
import {
  categoryNameSchema,
  imageExtension,
  MAX_IMAGE_BYTES,
  MAX_PRICE_PAISE,
  MENU_IMAGE_TYPES,
  menuItemPayloadSchema,
} from './schemas';

/**
 * Menu server actions (spec §13.3 Menu). Each re-checks the caller's role and
 * validates input; the database functions enforce the same rules again
 * (role, read-only, ownership) and own every write.
 */

const idSchema = z.uuid();
const idListSchema = z.array(z.uuid()).min(1).max(500);
const READ_ONLY_MESSAGE = dbErrorMessage({ code: 'P0001', message: 'RESTAURANT_READ_ONLY' })!;

function firstIssue(error: z.ZodError): ActionResult<never> {
  return actionError(error.issues[0]?.message ?? GENERIC_ERROR);
}

// ─── Categories ──────────────────────────────────────────────────────────────

export async function createCategory(name: string): Promise<ActionResult<{ id: string }>> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = categoryNameSchema.safeParse(name);
  if (!parsed.success) return firstIssue(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_create_category', { p_name: parsed.data });
  if (error) return fromDbError(error, 'admin_create_category');
  refresh();
  return actionOk({ id: data });
}

const categoryPatchSchema = z
  .object({ name: categoryNameSchema.optional(), isActive: z.boolean().optional() })
  .refine((patch) => patch.name !== undefined || patch.isActive !== undefined);

export async function updateCategory(
  id: string,
  patch: { name?: string; isActive?: boolean },
): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsedId = idSchema.safeParse(id);
  const parsed = categoryPatchSchema.safeParse(patch);
  if (!parsedId.success) return firstIssue(parsedId.error);
  if (!parsed.success) return firstIssue(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_update_category', {
    p_category_id: parsedId.data,
    p_patch: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.isActive !== undefined ? { is_active: parsed.data.isActive } : {}),
    },
  });
  if (error) return fromDbError(error, 'admin_update_category');
  refresh();
  return actionOk();
}

export async function deleteCategory(
  id: string,
  moveTo: string | null,
): Promise<ActionResult<{ moved: number }>> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = z.object({ id: z.uuid(), moveTo: z.uuid().nullable() }).safeParse({ id, moveTo });
  if (!parsed.success) return firstIssue(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_delete_category', {
    p_category_id: parsed.data.id,
    ...(parsed.data.moveTo ? { p_move_to: parsed.data.moveTo } : {}),
  });
  if (error) return fromDbError(error, 'admin_delete_category');
  refresh();
  return actionOk({ moved: data });
}

export async function addSuggestedCategories(
  set: string,
): Promise<ActionResult<{ added: number }>> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = z.enum(CUISINE_SETS).safeParse(set);
  if (!parsed.success) return actionError('Choose a set of categories.');

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_add_categories', {
    p_names: [...DEFAULT_CATEGORY_SETS[parsed.data]],
  });
  if (error) return fromDbError(error, 'admin_add_categories');
  refresh();
  return actionOk({ added: data });
}

export async function reorderCategories(ids: string[]): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = idListSchema.safeParse(ids);
  if (!parsed.success) return firstIssue(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_reorder', {
    p_kind: 'categories',
    p_ids: parsed.data,
  });
  if (error) return fromDbError(error, 'admin_reorder');
  refresh();
  return actionOk();
}

// ─── Items ───────────────────────────────────────────────────────────────────

export async function reorderItems(categoryId: string, ids: string[]): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsedCategory = idSchema.safeParse(categoryId);
  const parsed = idListSchema.safeParse(ids);
  if (!parsedCategory.success) return firstIssue(parsedCategory.error);
  if (!parsed.success) return firstIssue(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_reorder', {
    p_kind: 'items',
    p_ids: parsed.data,
    p_category_id: parsedCategory.data,
  });
  if (error) return fromDbError(error, 'admin_reorder');
  refresh();
  return actionOk();
}

const itemPatchSchema = z
  .object({
    pricePaise: z.number().int().min(0).max(MAX_PRICE_PAISE).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((patch) => patch.pricePaise !== undefined || patch.isActive !== undefined);

/** Quick edits from the list: price (dishes without options) and hide/show. */
export async function updateMenuItem(
  id: string,
  patch: { pricePaise?: number; isActive?: boolean },
): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsedId = idSchema.safeParse(id);
  const parsed = itemPatchSchema.safeParse(patch);
  if (!parsedId.success) return firstIssue(parsedId.error);
  if (!parsed.success) return firstIssue(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_update_menu_item', {
    p_item_id: parsedId.data,
    p_patch: {
      ...(parsed.data.pricePaise !== undefined ? { price_paise: parsed.data.pricePaise } : {}),
      ...(parsed.data.isActive !== undefined ? { is_active: parsed.data.isActive } : {}),
    },
  });
  if (error) return fromDbError(error, 'admin_update_menu_item');
  refresh();
  return actionOk();
}

/** "In stock" switch; any staff role (spec §9.3 staff_set_item_availability). */
export async function setItemAvailability(id: string, available: boolean): Promise<ActionResult> {
  await requireMember(STAFF_PANEL_ROLES);
  const parsed = z.object({ id: z.uuid(), available: z.boolean() }).safeParse({ id, available });
  if (!parsed.success) return firstIssue(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('staff_set_item_availability', {
    p_item_id: parsed.data.id,
    p_available: parsed.data.available,
  });
  if (error) return fromDbError(error, 'staff_set_item_availability');
  refresh();
  return actionOk();
}

/**
 * Saves a dish with its options, and its image when one is attached.
 * FormData: `item` (JSON payload in paise), optional `image` (already
 * compressed in the browser) and `removeImage` = "true".
 */
export async function saveMenuItem(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const membership = await requireMember(ADMIN_PANEL_ROLES);

  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get('item') ?? ''));
  } catch {
    return actionError(GENERIC_ERROR);
  }
  const parsed = menuItemPayloadSchema.safeParse(raw);
  if (!parsed.success) return fromZodError(parsed.error);
  const item = parsed.data;

  const image = formData.get('image');
  const newImage = image instanceof File && image.size > 0 ? image : null;
  const removeImage = formData.get('removeImage') === 'true';

  if (newImage) {
    if (!(MENU_IMAGE_TYPES as readonly string[]).includes(newImage.type)) {
      return actionError('Upload a JPG, PNG or WebP image.');
    }
    if (newImage.size > MAX_IMAGE_BYTES) return actionError('Images must be 1 MB or smaller.');
    // Don't leave uploads behind for a save the database will refuse.
    const access = await getRestaurantAccess(membership.restaurant.id);
    if (access.state !== 'full') return actionError(READ_ONLY_MESSAGE);
  }

  const supabase = await createClient();
  const images = supabase.storage.from('menu-images');
  const { data: existing } = await supabase
    .from('menu_items')
    .select('image_path')
    .eq('id', item.id)
    .maybeSingle();
  const oldPath = existing?.image_path ?? null;

  let imagePath = removeImage ? null : oldPath;
  if (newImage) {
    // One path per dish (spec §8.4): <restaurant_id>/<item_id>.<ext>
    imagePath = `${membership.restaurant.id}/${item.id}.${imageExtension(newImage.type)}`;
    const { error: uploadError } = await images.upload(imagePath, newImage, {
      upsert: true,
      contentType: newImage.type,
      cacheControl: '3600',
    });
    if (uploadError) {
      console.error('Menu image upload failed:', uploadError.message);
      return actionError('The image could not be uploaded. Try again.');
    }
  }

  const { data, error } = await supabase.rpc('admin_save_menu_item', {
    p_item: { ...item, image_path: imagePath },
  });
  if (error) return fromDbError(error, 'admin_save_menu_item');

  // Remove an image that is no longer used (replaced with another type, or removed).
  if (oldPath && oldPath !== imagePath) {
    const { error: removeError } = await images.remove([oldPath]);
    if (removeError) console.error('Old menu image not removed:', removeError.message);
  }

  refresh();
  return actionOk({ id: data });
}
