import type { init } from '@sentry/nextjs';

/**
 * Sentry for errors only (spec §17, docs/DECISIONS.md P10-3): no tracing, no
 * session replay, no personal data. Without a DSN (local, CI) nothing is sent.
 * One DSN serves the browser and the server; it is public by design.
 */
export const SENTRY_OPTIONS = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? 'development',
  // Sentry 11 collects all of these by default. None of them: the device cookie
  // and staff session cookies are credentials, a server action's body can hold
  // a password, and a stack frame's variables can hold either.
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    stackFrameVariables: false,
    databaseQueryData: false,
  },
} satisfies Parameters<typeof init>[0];
