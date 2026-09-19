import 'server-only';

import { z } from 'zod';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import { draftSchema, type Draft } from './draft';
import type { CurrentMenu } from './merge';

/** The import's pages, read with the caller's permissions (spec §20A, P7-15). */

export const IMPORT_BUCKET = 'menu-imports';

const pageSchema = z.object({
  index: z.number().int().positive(),
  status: z.enum(['pending', 'reading', 'done', 'failed']),
  claimed_at: z.string().nullish(),
  error: z.string().nullish(),
  notes: z.string().nullish(),
  provider: z.string().nullish(),
  model: z.string().nullish(),
  input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
  cost_paise: z.number().nullish(),
  result: z.unknown().optional(),
});
export type ImportPage = z.infer<typeof pageSchema>;

const countsSchema = z
  .object({
    categories_created: z.number(),
    categories_shown: z.number(),
    items_created: z.number(),
    items_updated: z.number(),
    items_skipped: z.number(),
  })
  .nullable()
  .catch(null);
export type ImportedCounts = NonNullable<z.infer<typeof countsSchema>>;

export type ImportStatus =
  'uploaded' | 'processing' | 'review' | 'imported' | 'failed' | 'discarded';

export type MenuImport = {
  id: string;
  restaurantId: string;
  source: 'photo' | 'csv';
  status: ImportStatus;
  pageCount: number;
  pages: ImportPage[];
  filePaths: string[];
  filesRemoved: boolean;
  draft: Draft | null;
  error: string | null;
  importedCounts: ImportedCounts | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costPaise: number | null;
  createdAt: string;
  completedAt: string | null;
};

const IMPORT_COLUMNS =
  'id, restaurant_id, source, status, page_count, pages, file_paths, files_removed_at, draft, error, imported_counts, model, input_tokens, output_tokens, cost_paise, created_at, completed_at';

type ImportRow = {
  id: string;
  restaurant_id: string;
  source: 'photo' | 'csv';
  status: ImportStatus;
  page_count: number;
  pages: unknown;
  file_paths: string[];
  files_removed_at: string | null;
  draft: unknown;
  error: string | null;
  imported_counts: unknown;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_paise: number | null;
  created_at: string;
  completed_at: string | null;
};

function toMenuImport(row: ImportRow): MenuImport {
  const pages = z.array(pageSchema).safeParse(row.pages);
  const draft = draftSchema.safeParse(row.draft);
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    source: row.source,
    status: row.status,
    pageCount: row.page_count,
    pages: pages.success ? pages.data : [],
    filePaths: row.file_paths,
    filesRemoved: row.files_removed_at !== null,
    draft: draft.success ? draft.data : null,
    error: row.error,
    importedCounts: countsSchema.parse(row.imported_counts),
    model: row.model,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    costPaise: row.cost_paise === null ? null : Number(row.cost_paise),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** One import, if the caller may see it (owner, manager or platform admin). */
export async function getMenuImport(importId: string): Promise<MenuImport | null> {
  if (!z.uuid().safeParse(importId).success) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('menu_imports')
    .select(IMPORT_COLUMNS)
    .eq('id', importId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the import: ${error.message}`);
  return data ? toMenuImport(data as ImportRow) : null;
}

export type ImportSummary = {
  id: string;
  source: 'photo' | 'csv';
  status: ImportStatus;
  pageCount: number;
  createdAt: string;
  items: number | null;
  costPaise: number | null;
};

/** Recent imports of a restaurant, newest first, to resume a draft or see what was done. */
export async function listMenuImports(restaurantId: string, limit = 10): Promise<ImportSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('menu_imports')
    .select('id, source, status, page_count, created_at, imported_counts, cost_paise')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not load imports: ${error.message}`);
  return data.map((row) => {
    const counts = countsSchema.parse(row.imported_counts);
    return {
      id: row.id,
      source: row.source,
      status: row.status,
      pageCount: row.page_count,
      createdAt: row.created_at,
      items: counts ? counts.items_created + counts.items_updated : null,
      costPaise: row.cost_paise === null ? null : Number(row.cost_paise),
    };
  });
}

export type ImportSpend = { photoImports: number; costPaise: number | null };

/**
 * What every photo import of a restaurant has cost so far (P7-13). Null when
 * any of them has an unknown cost, so the total is never understated.
 */
export async function menuImportSpend(restaurantId: string): Promise<ImportSpend> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('menu_imports')
    .select('cost_paise')
    .eq('restaurant_id', restaurantId)
    .eq('source', 'photo');
  if (error) throw new Error(`Could not add up import costs: ${error.message}`);
  const unknown = data.some((row) => row.cost_paise === null);
  return {
    photoImports: data.length,
    costPaise: unknown ? null : data.reduce((sum, row) => sum + Number(row.cost_paise), 0),
  };
}

/**
 * The restaurant's menu, for "Already in menu" and hidden-category checks.
 * Members read it through RLS; platform admins have no RLS access to menus,
 * so their pages (already behind requirePlatformAdmin) read it as the server.
 */
export async function getCurrentMenu(
  restaurantId: string,
  { asPlatformAdmin = false }: { asPlatformAdmin?: boolean } = {},
): Promise<CurrentMenu> {
  const supabase = asPlatformAdmin ? createAdminClient() : await createClient();
  const [categories, items] = await Promise.all([
    supabase
      .from('menu_categories')
      .select('id, name, is_active')
      .eq('restaurant_id', restaurantId)
      .order('sort_order'),
    supabase
      .from('menu_items')
      .select('id, category_id, name, is_active, variants:menu_item_variants (id, is_active)')
      .eq('restaurant_id', restaurantId),
  ]);
  if (categories.error) throw new Error(`Could not load categories: ${categories.error.message}`);
  if (items.error) throw new Error(`Could not load dishes: ${items.error.message}`);

  return {
    categories: categories.data.map((category) => ({
      id: category.id,
      name: category.name,
      isActive: category.is_active,
      items: items.data
        .filter((item) => item.category_id === category.id)
        .map((item) => ({
          id: item.id,
          name: item.name,
          isActive: item.is_active,
          hasVariants: item.variants.some((variant) => variant.is_active),
        })),
    })),
  };
}

/**
 * Short-lived links to the page photos, for the review thumbnails. Only called
 * with an import the caller could read (getMenuImport), since the bucket is private.
 */
export async function pageImageUrls(menuImport: MenuImport): Promise<Record<number, string>> {
  if (
    menuImport.source !== 'photo' ||
    menuImport.filesRemoved ||
    menuImport.filePaths.length === 0
  ) {
    return {};
  }
  const { data, error } = await createAdminClient()
    .storage.from(IMPORT_BUCKET)
    .createSignedUrls(menuImport.filePaths, 60 * 60);
  if (error) {
    console.error('Could not sign import page links:', error.message);
    return {};
  }
  const urls: Record<number, string> = {};
  data.forEach((entry, index) => {
    if (entry.signedUrl) urls[index + 1] = entry.signedUrl;
  });
  return urls;
}
