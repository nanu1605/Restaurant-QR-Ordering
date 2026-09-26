/**
 * Sentry for errors only (spec §17, docs/DECISIONS.md P10-3): no tracing, no
 * session replay, no personal data. Without a DSN (local, CI) nothing is sent.
 * One DSN serves the browser and the server; it is public by design.
 */
export const SENTRY_OPTIONS = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? 'development',
  sendDefaultPii: false,
};
