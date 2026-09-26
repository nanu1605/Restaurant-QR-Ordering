/**
 * The Content-Security-Policy every page gets (spec §19 Phase 9,
 * docs/DECISIONS.md P9-9). Scripts run only with this request's nonce (Next.js
 * adds it to its own) or when a nonced script loads them, as Razorpay Checkout
 * is. Styles stay 'unsafe-inline': the UI kit and toasts set inline styles.
 */
export function contentSecurityPolicy({
  nonce,
  supabaseUrl,
  dev,
}: {
  nonce: string;
  supabaseUrl: string;
  /** React needs eval in development for its error overlays. */
  dev: boolean;
}): string {
  const supabase = new URL(supabaseUrl);
  const secure = supabase.protocol === 'https:';
  // Realtime is a WebSocket on the Supabase host.
  const realtime = `${secure ? 'wss' : 'ws'}://${supabase.host}`;
  const razorpay = 'https://*.razorpay.com';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${razorpay}${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${supabase.origin} ${razorpay}`,
    "font-src 'self'",
    `connect-src 'self' ${supabase.origin} ${realtime} ${razorpay}`,
    `frame-src ${razorpay}`,
    // The service worker and the PDF reader for menu imports.
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Local and CI runs serve over http.
    ...(secure ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
