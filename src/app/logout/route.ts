import { createClient } from '@/lib/supabase/server';

/**
 * Log out this device only: staff often share one login across tablets, so a
 * global sign-out would kick every other device off too. A plain form post and
 * a full page load rather than a server action, so the old page, and any dish
 * moves it still holds in memory, can't outlive the session (docs/DECISIONS.md
 * P9-5). The auth cookies are SameSite=Lax: another site can't post here with them.
 *
 * Answers with a relative address: behind a proxy, request.url is the server's own,
 * and Next.js only rewrites the proxy's redirects (docs/DECISIONS.md VPS-3).
 */
export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: 'local' });
  return new Response(null, { status: 303, headers: { Location: '/login' } });
}
