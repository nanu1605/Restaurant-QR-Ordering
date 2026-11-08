'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';

import { queueHindiNames } from '@/features/menu/hindi-names';
import { actionError, actionOk, fromDbError, type ActionResult } from '@/lib/action-result';
import { requireUser } from '@/lib/auth/guards';
import { dbErrorCode, GENERIC_ERROR, type DbErrorLike } from '@/lib/db-errors';
import { getServerEnv } from '@/lib/env.server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { Json } from '@/types/database';

import { csvToDraft, MAX_CSV_BYTES, type CsvError } from './csv-reader';
import {
  commitPayload,
  draftSchema,
  MAX_IMPORT_PAGES,
  pageExtractionSchema,
  type Draft,
} from './draft';
import { extractPage, PAGE_DEADLINE_MS, READER_UNAVAILABLE } from './extract';
import { mergePages } from './merge';
import { menuImportProviders } from './providers';
import { IMPORT_BUCKET, type ImportedCounts } from './queries';

/**
 * Menu import steps (spec §20A.1, docs/DECISIONS.md P7-14 to P7-18). The
 * database functions decide who may do what; the server only signs uploads
 * and reads photos with the service role after the caller's own client could
 * create or read the import.
 */

const uuid = z.uuid();

const NOT_FOUND = 'That import no longer exists. Start a new one from the Menu page.';
const NO_DISHES_FOUND =
  'No dishes could be read from these photos. Take a sharper photo, straight on and in good light, of one page at a time.';
// Opening the import again skips a page recorded as failed and finishes the reading without it
// (VPS-5): with no other page that can still give dishes, that fails the import.
const PHOTO_NOT_FETCHED =
  'The photo of this page could not be fetched. Try again. If you leave instead, the import goes on without this page when you open it again.';
const PHOTO_NOT_FETCHED_ONLY_PAGE =
  'The photo of this page could not be fetched. Try again. If you leave instead, the import fails when you open it again, and you will need to start a new one.';

function importError(error: DbErrorLike, context: string) {
  const detail = error.details ?? '';
  const dish = detail ? ` “${detail}”` : '';
  switch (dbErrorCode(error)) {
    case 'INVALID_ITEM_NAME':
      return actionError(`A dish name${dish} is missing or longer than 80 characters.`);
    case 'INVALID_PRICE':
      return actionError(`Check the price of${dish || ' a dish'}: enter ₹0 to ₹10,00,000.`);
    case 'INVALID_VARIANT_NAME':
      return actionError(`Give each option of${dish || ' a dish'} a name of up to 40 characters.`);
    case 'VARIANT_NAME_DUPLICATE':
      return actionError(`Two options of${dish || ' a dish'} have the same name.`);
    case 'INVALID_CATEGORY_NAME':
      return actionError('Give every category a name of up to 60 characters.');
    case 'ITEM_HAS_VARIANTS':
      return actionError(
        `${dish || 'That dish'} already has options on the menu. Give this row the same options, or add it as a new dish.`,
      );
    case 'VARIANTS_DIFFER':
      return actionError(
        `The options of${dish || ' a dish'} don't match the ones on the menu. Use the same option names, or add it as a new dish.`,
      );
    case 'NOT_FOUND':
      return actionError(
        detail === 'existing_item_id'
          ? 'A dish to update is no longer on the menu. Reload the page to check again.'
          : NOT_FOUND,
      );
    default:
      return fromDbError(error, context);
  }
}

export type PhotoUpload = { path: string; token: string };

/** Creates a photo import and signed upload links, one per page. */
export async function startPhotoImport(
  restaurantId: string,
  pageCount: number,
): Promise<ActionResult<{ importId: string; uploads: PhotoUpload[] }>> {
  await requireUser();
  if (!uuid.safeParse(restaurantId).success) return actionError(GENERIC_ERROR);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_IMPORT_PAGES) {
    return actionError(`Choose 1 to ${MAX_IMPORT_PAGES} pages.`);
  }
  if (menuImportProviders().length === 0) {
    return actionError('Photo import is not set up. Import a CSV file or add dishes by hand.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('menu_import_create', {
    p_restaurant_id: restaurantId,
    p_source: 'photo',
    p_page_count: pageCount,
  });
  if (error) return importError(error, 'Start photo import');
  const created = data as { import_id: string; file_paths: string[] };

  const storage = createAdminClient().storage.from(IMPORT_BUCKET);
  const uploads: PhotoUpload[] = [];
  for (const path of created.file_paths) {
    const signed = await storage.createSignedUploadUrl(path, { upsert: true });
    if (signed.error) {
      console.error('Could not sign an import upload:', signed.error.message);
      return actionError(GENERIC_ERROR);
    }
    uploads.push({ path, token: signed.data.token });
  }
  return actionOk({ importId: created.import_id, uploads });
}

export type CsvImportOutcome =
  | { kind: 'created'; importId: string }
  | { kind: 'invalid'; errors: CsvError[]; moreErrors: number };

/** Reads a CSV into a draft and opens it for review. Nothing reaches the menu yet. */
export async function startCsvImport(
  restaurantId: string,
  csv: string,
): Promise<ActionResult<CsvImportOutcome>> {
  await requireUser();
  if (!uuid.safeParse(restaurantId).success || typeof csv !== 'string') {
    return actionError(GENERIC_ERROR);
  }
  if (csv.length > MAX_CSV_BYTES * 2) {
    return actionOk({
      kind: 'invalid',
      errors: [
        { row: null, message: 'The file is larger than 1 MB. Split it into smaller files.' },
      ],
      moreErrors: 0,
    });
  }
  const parsed = csvToDraft(csv);
  if (!parsed.ok) {
    return actionOk({ kind: 'invalid', errors: parsed.errors, moreErrors: parsed.moreErrors });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('menu_import_create', {
    p_restaurant_id: restaurantId,
    p_source: 'csv',
    p_page_count: 0,
  });
  if (error) return importError(error, 'Start CSV import');
  const importId = (data as { import_id: string }).import_id;

  const saved = await supabase.rpc('menu_import_set_draft', {
    p_import_id: importId,
    p_status: 'review',
    p_draft: parsed.draft as unknown as Json,
  });
  if (saved.error) return importError(saved.error, 'Save CSV draft');
  return actionOk({ kind: 'created', importId });
}

export type ReadProgress = { total: number; done: number; failed: number };

type PageRow = { index: number; status: string };

function progressOf(pages: PageRow[]): ReadProgress {
  return {
    total: pages.length,
    done: pages.filter((page) => page.status === 'done').length,
    failed: pages.filter((page) => page.status === 'failed').length,
  };
}

/** A page photo is a few hundred KB from Storage: a stall mustn't eat the reader's time. */
const PHOTO_TIMEOUT_MS = 15_000;

/**
 * Whether Storage said the object is not there. It answers a missing one with status 400 and
 * statusCode '404' in its body; a proxy in front of it may answer 404 itself.
 */
function isNotFound(error: { status?: number; statusCode?: string } | null) {
  return error?.status === 404 || error?.statusCode === '404';
}

/** Reads one page (spec §20A.1 step 2: one page per request). */
export async function readMenuPage(
  importId: string,
  page: number,
): Promise<ActionResult<ReadProgress>> {
  // The page's time counts from here, so the answer beats Cloudflare's 100 s cut
  // (docs/DECISIONS.md P7-15, VPS-5).
  const started = Date.now();
  await requireUser();
  if (!uuid.safeParse(importId).success || !Number.isInteger(page) || page < 1) {
    return actionError(GENERIC_ERROR);
  }

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from('menu_imports')
    .select('status, source, file_paths, pages')
    .eq('id', importId)
    .maybeSingle();
  if (error) return fromDbError(error, 'Load import');
  if (!row || row.source !== 'photo') return actionError(NOT_FOUND);

  const pages = (row.pages as PageRow[]) ?? [];
  const entry = pages[page - 1];
  const path = row.file_paths[page - 1];
  if (!entry || !path) return actionError(GENERIC_ERROR);
  if (!['uploaded', 'processing'].includes(row.status) || entry.status === 'done') {
    return actionOk(progressOf(pages));
  }

  // The caller could read the import, so from here the server acts for it: it
  // claims the page (so a reload or a second tab doesn't pay for the same page
  // twice), fetches the photo and records what the reader charged.
  const admin = createAdminClient();
  const claim = await admin.rpc('menu_import_claim_page', {
    p_import_id: importId,
    p_index: page,
  });
  if (claim.error) return importError(claim.error, 'Claim import page');
  if (!claim.data) return actionOk(await progressFor(supabase, importId, pages));

  const photoTimer = AbortSignal.timeout(PHOTO_TIMEOUT_MS);
  let photo: Blob | null = null;
  let missing = false;
  try {
    const download = await admin.storage
      .from(IMPORT_BUCKET)
      .download(path, {}, { signal: photoTimer });
    photo = download.data;
    missing = isNotFound(download.error);
  } catch {
    // storage-js returns a failure that lands before the headers (the gateway's 503, a refused
    // connection, the timer), but throws one that lands while the body is read (the timer, or a
    // connection reset). The photo may still be in Storage either way, and the page is recorded
    // either way, or it stays claimed for 3 minutes and Try again skips it (docs/DECISIONS.md VPS-5).
  }
  const env = getServerEnv();
  const outcome = photo
    ? await extractPage({
        imageJpegBase64: Buffer.from(await photo.arrayBuffer()).toString('base64'),
        providers: menuImportProviders(env),
        usdToInr: env.MENU_IMPORT_USD_INR,
        // What the steps before the reader left of the page's time.
        deadlineMs: PAGE_DEADLINE_MS - (Date.now() - started),
      })
    : null;

  const record = outcome
    ? {
        index: page,
        status: outcome.status,
        error: outcome.error,
        notes: outcome.result?.page_notes ?? null,
        provider: outcome.provider,
        model: outcome.model,
        input_tokens: outcome.inputTokens,
        output_tokens: outcome.outputTokens,
        cost_paise: outcome.costPaise,
        result: outcome.result,
        raw: typeof outcome.raw === 'string' ? outcome.raw.slice(0, 100_000) : outcome.raw,
      }
    : {
        index: page,
        status: 'failed',
        // Only a photo Storage says is not there is lost for good. One that was slow, cut off or
        // out of reach is worth another try.
        error: missing
          ? 'The photo of this page did not upload. Start a new import with this page.'
          : READER_UNAVAILABLE,
      };

  const saved = await admin.rpc('menu_import_record_page', {
    p_import_id: importId,
    p_page: record as unknown as Json,
  });
  // The import may have been discarded or finished while the page was read:
  // the reading is lost, not the import.
  if (saved.error) {
    if (dbErrorCode(saved.error) === 'IMPORT_NOT_OPEN') {
      return actionOk(await progressFor(supabase, importId, pages));
    }
    return importError(saved.error, 'Record import page');
  }
  // A photo that did not arrive stops the reading, so that Try again reads the page once more:
  // going on would finish the import without it, and nothing could read it after that
  // (docs/DECISIONS.md VPS-5).
  if (!photo && !missing) {
    const othersLeft = pages.some((other) => other.index !== page && other.status !== 'failed');
    return actionError(othersLeft ? PHOTO_NOT_FETCHED : PHOTO_NOT_FETCHED_ONLY_PAGE);
  }
  return actionOk(saved.data as ReadProgress);
}

/** The progress as the database has it now, falling back to what we last saw. */
async function progressFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  importId: string,
  fallback: PageRow[],
): Promise<ReadProgress> {
  const { data } = await supabase
    .from('menu_imports')
    .select('pages')
    .eq('id', importId)
    .maybeSingle();
  return progressOf((data?.pages as PageRow[]) ?? fallback);
}

/** Merges the pages read into one draft, or fails the import when nothing was found. */
export async function finishReading(
  importId: string,
): Promise<ActionResult<{ status: 'review' | 'failed' }>> {
  await requireUser();
  if (!uuid.safeParse(importId).success) return actionError(GENERIC_ERROR);

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from('menu_imports')
    .select('status, pages')
    .eq('id', importId)
    .maybeSingle();
  if (error) return fromDbError(error, 'Load import');
  if (!row) return actionError(NOT_FOUND);
  if (row.status === 'review' || row.status === 'failed') return actionOk({ status: row.status });
  if (!['uploaded', 'processing'].includes(row.status)) return actionError(NOT_FOUND);

  const pages = (row.pages ?? []) as Array<{
    index: number;
    status: string;
    error?: string | null;
    notes?: string | null;
    result?: unknown;
  }>;
  if (pages.some((page) => page.status === 'pending' || page.status === 'reading')) {
    return actionError('Some pages have not been read yet.');
  }

  const read = pages.flatMap((page) => {
    if (page.status !== 'done') return [];
    const parsed = pageExtractionSchema.safeParse(page.result);
    return parsed.success ? [{ page: page.index, extraction: parsed.data }] : [];
  });
  const draft = mergePages(read);
  const items = draft.categories.reduce((sum, category) => sum + category.items.length, 0);

  if (items === 0) {
    const unavailable = pages.every((page) => page.error === READER_UNAVAILABLE);
    const note = pages.find((page) => page.notes)?.notes;
    const message = unavailable
      ? 'The menu reader is not answering right now. Try again in a few minutes.'
      : note
        ? `${NO_DISHES_FOUND} (${note.slice(0, 200)})`
        : NO_DISHES_FOUND;
    const failed = await supabase.rpc('menu_import_set_draft', {
      p_import_id: importId,
      p_status: 'failed',
      p_error: message.slice(0, 500),
    });
    if (failed.error) return importError(failed.error, 'Fail import');
    refresh();
    return actionOk({ status: 'failed' });
  }

  const saved = await supabase.rpc('menu_import_set_draft', {
    p_import_id: importId,
    p_status: 'review',
    p_draft: draft as unknown as Json,
  });
  if (saved.error) return importError(saved.error, 'Save import draft');
  refresh();
  return actionOk({ status: 'review' });
}

/** "Save draft and finish later" (§20A.4). */
export async function saveImportDraft(importId: string, draft: Draft): Promise<ActionResult> {
  await requireUser();
  const parsed = draftSchema.safeParse(draft);
  if (!uuid.safeParse(importId).success || !parsed.success) return actionError(GENERIC_ERROR);

  const supabase = await createClient();
  const { error } = await supabase.rpc('menu_import_set_draft', {
    p_import_id: importId,
    p_status: 'review',
    p_draft: parsed.data as unknown as Json,
  });
  if (error) return importError(error, 'Save import draft');
  return actionOk();
}

/** Writes the reviewed draft to the menu in one transaction (§20A.5). */
export async function commitMenuImport(
  importId: string,
  draft: Draft,
  confirmFoodTypes: boolean,
): Promise<ActionResult<ImportedCounts & { already_imported?: boolean }>> {
  await requireUser();
  const parsed = draftSchema.safeParse(draft);
  if (!uuid.safeParse(importId).success || !parsed.success) return actionError(GENERIC_ERROR);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('menu_import_commit', {
    p_import_id: importId,
    p_draft: commitPayload(parsed.data) as unknown as Json,
    p_confirm_food_types: confirmFoodTypes === true,
  });
  if (error) return importError(error, 'Import menu');
  const { data: menuImport } = await supabase
    .from('menu_imports')
    .select('restaurant_id')
    .eq('id', importId)
    .maybeSingle();
  if (menuImport) queueHindiNames(menuImport.restaurant_id);
  refresh();
  return actionOk(data as ImportedCounts & { already_imported?: boolean });
}

export async function discardMenuImport(importId: string): Promise<ActionResult> {
  await requireUser();
  if (!uuid.safeParse(importId).success) return actionError(GENERIC_ERROR);
  const supabase = await createClient();
  const { error } = await supabase.rpc('menu_import_discard', { p_import_id: importId });
  if (error) return importError(error, 'Discard import');
  refresh();
  return actionOk();
}
