import 'server-only';

import type { createAdminClient } from '@/lib/supabase/admin';

import { IMPORT_BUCKET } from './queries';

/**
 * Deletes menu import photos once they are no longer needed (spec §20A.1
 * step 5, docs/DECISIONS.md P7-20): 7 days after an import ends, or 30 days
 * after one that never finished. The drafts and counts stay.
 */
export async function removeOldImportPhotos(
  admin: ReturnType<typeof createAdminClient>,
  batches = 5,
): Promise<{ imports: number; files: number }> {
  let imports = 0;
  let files = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const { data, error } = await admin.rpc('menu_import_files_to_remove', { p_limit: 200 });
    if (error) throw new Error(`Could not list import photos: ${error.message}`);
    if (data.length === 0) break;

    const paths = data.flatMap((row) => row.file_paths);
    // Missing files are not an error: an upload may never have happened.
    const removed = await admin.storage.from(IMPORT_BUCKET).remove(paths);
    if (removed.error) throw new Error(`Could not delete import photos: ${removed.error.message}`);

    const marked = await admin.rpc('menu_import_mark_files_removed', {
      p_import_ids: data.map((row) => row.import_id),
    });
    if (marked.error) throw new Error(`Could not mark import photos: ${marked.error.message}`);
    imports += marked.data;
    files += removed.data.length;
    if (data.length < 200) break;
  }
  return { imports, files };
}
