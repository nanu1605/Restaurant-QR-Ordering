import * as Sentry from '@sentry/nextjs';

import { SENTRY_OPTIONS } from '@/lib/sentry-options';

export function register() {
  Sentry.init({
    ...SENTRY_OPTIONS,
    // Unexpected database errors are logged with console.error (the customer
    // actions, health, cron); they reach Sentry without touching each caller.
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
  });
}

/** Errors thrown while rendering or in route handlers and server actions. */
export const onRequestError = Sentry.captureRequestError;
