import { createBrowserClient } from '@supabase/ssr';

import { getPublicEnv } from '@/lib/env';
import { supabaseAuthCookieName } from '@/lib/supabase/cookie-name';
import type { Database } from '@/types/database';

/**
 * Supabase client for Client Components (staff/admin live views, Realtime).
 * `createBrowserClient` returns a shared instance in the browser. It always calls the
 * public address, never SUPABASE_INTERNAL_URL (docs/DECISIONS.md VPS-20).
 */
export function createClient() {
  const env = getPublicEnv();
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    // The cookie the server clients write, named from the same public address.
    { cookieOptions: { name: supabaseAuthCookieName(env.NEXT_PUBLIC_SUPABASE_URL) } },
  );
}
