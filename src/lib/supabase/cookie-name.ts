/**
 * The name of the cookie that holds the Supabase session, for the server and the browser
 * clients alike. supabase-js names it after the first label of the address it is given
 * (sb-<label>-auth-token), but the server may reach Supabase on another address than the
 * browser does (SUPABASE_INTERNAL_URL, docs/DECISIONS.md VPS-20), and the browser reads the
 * very cookie the server writes. So it is pinned to the name of the public address: the name
 * supabase-js gives it today, so no session changes.
 */
export function supabaseAuthCookieName(publicUrl: string): string {
  return `sb-${new URL(publicUrl).hostname.split('.')[0]}-auth-token`;
}
