import { isUnrecognizedAction } from '@/features/new-version/stale';
import { SENTRY_OPTIONS } from '@/lib/sentry-options';

// Zod compiles fast parsers with `new Function`. The pages' policy forbids
// eval, and even Zod's caught probe for it reports a violation
// (docs/DECISIONS.md P9-9), so parse without it in the browser. Zod keeps its
// settings in this global (the same object whether it loads before or after
// this file); importing Zod here would put it on every page.
const holder = globalThis as { __zod_globalConfig?: Record<string, unknown> };
(holder.__zod_globalConfig ??= {}).jitless = true;

// Sentry's browser SDK is about 50 KB gzipped: it loads once the page is idle,
// so the customer menu doesn't wait for it (docs/DECISIONS.md P10-3). Errors
// before then only reach Sentry from the server.
if (SENTRY_OPTIONS.enabled) {
  const load = () =>
    void import('@sentry/nextjs').then((Sentry) =>
      Sentry.init({
        ...SENTRY_OPTIONS,
        // Errors only: no session ping on every page load.
        integrations: (defaults) => defaults.filter((i) => i.name !== 'BrowserSession'),
        // An older build's action after a deploy is no bug: the page refreshes onto the new
        // build, and the server logs a "Failed to find Server Action" warning for each
        // (docs/DECISIONS.md VPS-9). A script that didn't load is still reported.
        beforeSend: (event, hint) => (isUnrecognizedAction(hint.originalException) ? null : event),
      }),
    );
  if ('requestIdleCallback' in window) window.requestIdleCallback(load, { timeout: 3000 });
  else setTimeout(load, 1000);
}
