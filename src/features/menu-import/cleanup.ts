import 'server-only';

import type { createAdminClient } from '@/lib/supabase/admin';

import { IMPORT_BUCKET } from './queries';

/**
 * Deletes menu import photos once they are no longer needed (spec §20A.1
 * step 5, docs/DECISIONS.md P7-20): 7 days after an import ends, or 30 days
 * after one that never finished. The drafts and counts stay.
 */
const BATCH = 200;
const DELETE_CHUNK = 500;

export async function removeOldImportPhotos(
  admin: ReturnType<typeof createAdminClient>,
  batches = 5,
): Promise<{ imports: number; files: number }> {
  let imports = 0;
  let files = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const { data, error } = await admin.rpc('menu_import_files_to_remove', { p_limit: BATCH });
    if (error) throw new Error(`Could not list import photos: ${error.message}`);
    if (data.length === 0) break;

    const paths = data.flatMap((row) => row.file_paths);
    // Missing files are not an error: an upload may never have happened. The
    // Storage delete endpoint takes at most 1000 paths, so they go in chunks.
    for (let from = 0; from < paths.length; from += DELETE_CHUNK) {
      const removed = await admin.storage
        .from(IMPORT_BUCKET)
        .remove(paths.slice(from, from + DELETE_CHUNK));
      if (removed.error)
        throw new Error(`Could not delete import photos: ${removed.error.message}`);
      files += removed.data.length;
    }

    const marked = await admin.rpc('menu_import_mark_files_removed', {
      p_import_ids: data.map((row) => row.import_id),
    });
    if (marked.error) throw new Error(`Could not mark import photos: ${marked.error.message}`);
    imports += marked.data;
    if (data.length < BATCH) break;
  }
  return { imports, files };
}
