import * as Sentry from '@sentry/nextjs';

import { SENTRY_OPTIONS } from '@/lib/sentry-options';

export async function register() {
  Sentry.init({
    ...SENTRY_OPTIONS,
    // Unexpected database errors are logged with console.error (the customer
    // actions, health, cron); they reach Sentry without touching each caller.
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
  });
  // At SIGTERM the jobs stop claiming work (docs/DECISIONS.md VPS-25). The edge runtime has no
  // process signals.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    (await import('@/lib/shutdown')).stopJobsOnSigterm();
  }
}

/** Errors thrown while rendering or in route handlers and server actions. */
export const onRequestError = Sentry.captureRequestError;
