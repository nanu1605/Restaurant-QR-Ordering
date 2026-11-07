import 'server-only';

import { cache } from 'react';

import { formatDateTime } from '@/features/platform/platform';
import { formatBytes } from '@/features/system/system';
import { APP_NAME } from '@/lib/config';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { toPublicSupabaseUrl } from '@/lib/supabase/url';

import { parseClosure, parseExportRow, type DataExport } from './closure';
import { EXPORT_BUCKET } from './export';

/** A restaurant's closing, or null while it is open. */
export const getClosure = cache(async (restaurantId: string) => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_closure', { p_restaurant_id: restaurantId });
  if (error) throw new Error(`Could not load the closure: ${error.message}`);
  return parseClosure(data);
});

async function toDataExport(json: unknown, slug: string): Promise<DataExport> {
  const row = parseExportRow(json);
  if (!row) return { state: 'none' };
  if (row.status !== 'ready' || !row.expires_at) {
    return { state: row.status === 'building' ? 'building' : 'failed' };
  }
  // The link ends when the export does (docs/DECISIONS.md SA-93).
  const seconds = Math.floor((Date.parse(row.expires_at) - Date.now()) / 1000);
  if (seconds < 60) return { state: 'expired' };
  const { data, error } = await createAdminClient()
    .storage.from(EXPORT_BUCKET)
    .createSignedUrl(row.path, seconds, {
      download: `${APP_NAME.toLowerCase()}-${slug}-${row.created_at.slice(0, 10)}.zip`,
    });
  if (error) {
    console.error('[closure] no link for an export', error);
    return { state: 'failed' };
  }
  return {
    state: 'ready',
    url: toPublicSupabaseUrl(data.signedUrl),
    size: formatBytes(row.size_bytes ?? 0),
    until: formatDateTime(row.expires_at),
    secondsLeft: seconds,
  };
}

/** The owner's latest export, from their own session. */
export async function getOwnerExport(slug: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_data_export');
  if (error) throw new Error(`Could not load the export: ${error.message}`);
  return toDataExport(data, slug);
}

/** A restaurant's latest export, for the team (restaurants.close). */
export async function getTeamExport(restaurantId: string, slug: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_data_export', {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(`Could not load the export: ${error.message}`);
  return toDataExport(data, slug);
}
