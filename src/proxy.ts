import type { NextRequest } from 'next/server';

import { withDeviceCookie } from '@/features/ordering/device';
import { updateSession } from '@/lib/supabase/proxy';

export async function proxy(request: NextRequest) {
  // Customer pages (/t/<qr token>/…) have no staff session: they only need the
  // signed device cookie, which keeps them fast.
  if (request.nextUrl.pathname.startsWith('/t/')) return withDeviceCookie(request);
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets and API routes (they authenticate themselves).
    // Server actions post to their page's path, so /t/* actions pass through here too.
    '/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
