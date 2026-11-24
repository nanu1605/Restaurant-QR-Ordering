import 'server-only';

import { createClient } from '@supabase/supabase-js';

import { getServerEnv } from '@/lib/env.server';
import { supabaseServerUrl } from '@/lib/supabase/url';
import type { Database } from '@/types/database';

/**
 * Privileged Supabase client using the secret (service role) key. Bypasses RLS.
 *
 * Only for: customer_* functions (called from server actions), platform admin
 * actions, and staff account creation via the Auth Admin API. Never import this
 * from client code — `server-only` makes that a build error.
 */
export function createAdminClient() {
  return createClient<Database>(supabaseServerUrl(), getServerEnv().SUPABASE_SECRET_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
