import 'server-only';

import { cache } from 'react';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { toPublicSupabaseUrl } from '@/lib/supabase/url';

import { parseInbox, parseSupportRequest, SCREENSHOT_BUCKET, type InboxFilters } from './support';

/** The support inbox (docs/DECISIONS.md SA-43), 50 a page. */
export async function listSupportRequests(filters: InboxFilters) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_list_support_requests', {
    p_filters: filters,
  });
  if (error) throw new Error(`Could not load the support requests: ${error.message}`);
  return parseInbox(data);
}

/**
 * One request, or null when there is none, with a link to its screenshot that
 * works for an hour. The bucket has no storage policies, so the link is signed
 * with the service role after the platform admin's own read of the request.
 */
// One read per request: the page's title and the page both ask.
export const getSupportRequest = cache(async (requestId: string) => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_get_support_request', {
    p_request_id: requestId,
  });
  if (error) {
    if (error.message === 'NOT_FOUND' || error.code === '22P02') return null;
    throw new Error(`Could not load the support request: ${error.message}`);
  }
  const request = parseSupportRequest(data);
  let screenshotUrl: string | null = null;
  if (request.screenshot_path) {
    const signed = await createAdminClient()
      .storage.from(SCREENSHOT_BUCKET)
      .createSignedUrl(request.screenshot_path, 60 * 60);
    if (signed.error) console.error('[support] no link for a screenshot', signed.error);
    screenshotUrl = signed.data ? toPublicSupabaseUrl(signed.data.signedUrl) : null;
  }
  return { request, screenshotUrl };
});
