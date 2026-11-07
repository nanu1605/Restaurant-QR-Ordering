/**
 * The visitor's IP address in a request's headers, as the host reports it: X-Real-IP, which the
 * proxy in front of the app overwrites with it (docs/DECISIONS.md VPS-4), else the first
 * X-Forwarded-For entry. For rate limits and for Supabase Auth.
 */
export function ipFromHeaders(requestHeaders: Pick<Headers, 'get'>): string | null {
  return (
    requestHeaders.get('x-real-ip') ??
    requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  );
}
