import 'server-only';

import { createClient } from '@/lib/supabase/server';

import { parseOwnerRequests } from './support';

/** The restaurant's own requests (newest 50), each with its status changes. */
export async function listOwnerSupportRequests() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_list_support_requests');
  if (error) throw new Error(`Could not load the requests: ${error.message}`);
  return parseOwnerRequests(data);
}
