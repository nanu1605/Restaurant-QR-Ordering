import type { NextRequest } from 'next/server';

import { withDeviceCookie } from '@/features/ordering/device';
import { APP_DOMAIN } from '@/lib/config';
import { contentSecurityPolicy } from '@/lib/csp';
import { getPublicEnv } from '@/lib/env';
import { updateSession } from '@/lib/supabase/proxy';

export async function proxy(request: NextRequest) {
  // A fresh nonce per request: Next.js reads it from the request's policy and
  // puts it on its scripts (docs/DECISIONS.md P9-9). Both steps below forward
  // the request's headers.
  const env = getPublicEnv();
  const csp = contentSecurityPolicy({
    nonce: btoa(crypto.randomUUID()),
    appUrl: env.NEXT_PUBLIC_APP_URL,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    sentryDsn: env.NEXT_PUBLIC_SENTRY_DSN,
    posthogHost: env.NEXT_PUBLIC_POSTHOG_KEY
      ? (env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com')
      : undefined,
    dev: process.env.NODE_ENV === 'development',
  });
  request.headers.set('Content-Security-Policy', csp);

  // Customer pages (/t/<qr token>/…) have no staff session: they only need the
  // signed device cookie, which keeps them fast.
  const response = request.nextUrl.pathname.startsWith('/t/')
    ? await withDeviceCookie(request)
    : await updateSession(request);
  response.headers.set('Content-Security-Policy', csp);
  // Only menumesh.in is for search engines: not staging, Vercel's own addresses or local runs
  // (docs/DECISIONS.md W-12).
  if (request.nextUrl.hostname !== APP_DOMAIN) response.headers.set('X-Robots-Tag', 'noindex');
  return response;
}

export const config = {
  matcher: [
    // Everything except static assets, the install and search-engine files and API routes
    // (they authenticate themselves).
    // Server actions post to their page's path, so /t/* actions pass through here too.
    '/((?!_next/static|_next/image|favicon.ico|icon/|apple-icon|sw\\.js|app\\.webmanifest|robots\\.txt|sitemap\\.xml|opengraph-image|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
