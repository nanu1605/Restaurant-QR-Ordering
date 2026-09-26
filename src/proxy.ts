import type { NextRequest } from 'next/server';

import { withDeviceCookie } from '@/features/ordering/device';
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
    dev: process.env.NODE_ENV === 'development',
  });
  request.headers.set('Content-Security-Policy', csp);

  // Customer pages (/t/<qr token>/…) have no staff session: they only need the
  // signed device cookie, which keeps them fast.
  const response = request.nextUrl.pathname.startsWith('/t/')
    ? await withDeviceCookie(request)
    : await updateSession(request);
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    // Everything except static assets, the install files, API routes (they
    // authenticate themselves) and the Sentry relay.
    // Server actions post to their page's path, so /t/* actions pass through here too.
    '/((?!_next/static|_next/image|favicon.ico|icon/|apple-icon|sw\\.js|app\\.webmanifest|api/|monitoring|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
