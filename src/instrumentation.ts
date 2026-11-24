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
    const listening = (await import('@/lib/shutdown')).stopJobsOnSigterm();
    // Next.js adds its own listener before this runs, so this is false only when an upgrade or
    // NEXT_MANUAL_SIG_HANDLE changed that: a stop would then run job work to the kill. Said once,
    // in the logs, which docker:check reads. Not on Vercel, which stops its functions its own way.
    if (!listening && !process.env.VERCEL) {
      console.warn(
        '[jobs] no SIGTERM listener before register(): a stop runs job work to the kill',
      );
    }
  }
}

/** Errors thrown while rendering or in route handlers and server actions. */
export const onRequestError = Sentry.captureRequestError;
