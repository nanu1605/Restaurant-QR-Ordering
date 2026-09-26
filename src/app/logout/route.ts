import { type NextRequest, NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';

/**
 * Log out this device only: staff often share one login across tablets, so a
 * global sign-out would kick every other device off too. A plain form post and
 * a full page load rather than a server action, so the old page, and any dish
 * moves it still holds in memory, can't outlive the session (docs/DECISIONS.md
 * P9-5). The auth cookies are SameSite=Lax: another site can't post here with them.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: 'local' });
  return NextResponse.redirect(new URL('/login', request.url), 303);
}
