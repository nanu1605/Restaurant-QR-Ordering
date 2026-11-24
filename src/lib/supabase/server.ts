import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { cookies, headers } from 'next/headers';

import { getPublicEnv } from '@/lib/env';
import { supabaseAuthCookieName } from '@/lib/supabase/cookie-name';
import { forwardedVisitorIp, forwardingFetch } from '@/lib/supabase/forwarded-for';
import { supabaseServerUrl } from '@/lib/supabase/url';
import type { Database } from '@/types/database';

/**
 * Supabase client for Server Components, Server Actions and Route Handlers,
 * acting as the signed-in staff user (RLS applies). Create one per request.
 */
export async function createClient() {
  const env = getPublicEnv();
  const cookieStore = await cookies();
  const serverUrl = supabaseServerUrl();
  // Sign-ins, refreshes and second-factor codes name the visitor to Supabase Auth, when it
  // takes that (docs/DECISIONS.md VPS-4).
  const visitorIp = await forwardedVisitorIp(headers);

  return createServerClient<Database>(serverUrl, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    // The browser reads this cookie too, whichever address the server calls Supabase on
    // (docs/DECISIONS.md VPS-20).
    cookieOptions: { name: supabaseAuthCookieName(env.NEXT_PUBLIC_SUPABASE_URL) },
    ...(visitorIp ? { global: { fetch: forwardingFetch(serverUrl, visitorIp) } } : null),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // The request proxy refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}
