import type { NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/proxy';

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets, API routes (they authenticate themselves)
    // and the customer menu /t/* (no staff session there; keep it fast).
    '/((?!_next/static|_next/image|favicon.ico|api/|t/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
