import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { getPublicEnv } from '@/lib/env';
import { supabaseAuthCookieName } from '@/lib/supabase/cookie-name';
import { forwardedVisitorIp, forwardingFetch } from '@/lib/supabase/forwarded-for';
import { supabaseServerUrl } from '@/lib/supabase/url';
import type { Database } from '@/types/database';

const PROTECTED_PREFIXES = ['/staff', '/admin', '/super'];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Refreshes the Supabase session cookie on every matched request and sends
 * signed-out visitors of /staff, /admin and /super to the login page.
 * Pages still check roles on the server (src/lib/auth/guards.ts).
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const env = getPublicEnv();
  let response = NextResponse.next({ request });
  const serverUrl = supabaseServerUrl();
  // The refresh below names the visitor to Supabase Auth, when it takes that
  // (docs/DECISIONS.md VPS-4).
  const visitorIp = await forwardedVisitorIp(() => request.headers);

  const supabase = createServerClient<Database>(
    serverUrl,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      // The same name as the server and the browser clients use (docs/DECISIONS.md VPS-20).
      cookieOptions: { name: supabaseAuthCookieName(env.NEXT_PUBLIC_SUPABASE_URL) },
      ...(visitorIp ? { global: { fetch: forwardingFetch(serverUrl, visitorIp) } } : null),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
          // no-store headers so a CDN never caches a response carrying a session.
          Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
        },
      },
    },
  );

  // Nothing may run between creating the client and getClaims(): it is what
  // refreshes an expired session.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  if (!signedIn && isProtected(request.nextUrl.pathname)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    loginUrl.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);

    const redirect = NextResponse.redirect(loginUrl);
    // Keep any cookie changes (e.g. a cleared expired session) on the redirect.
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }

  return response;
}
