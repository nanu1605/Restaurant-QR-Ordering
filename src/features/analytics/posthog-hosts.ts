/**
 * PostHog's hosts for a region's API host (`https://us.i.posthog.com` or
 * `https://eu.i.posthog.com`): the browser talks to /ingest on our own origin,
 * which next.config.ts rewrites to these (docs/DECISIONS.md P10-4).
 */
export function posthogHosts(apiHost = 'https://us.i.posthog.com') {
  const { protocol, hostname } = new URL(apiHost);
  return {
    api: `${protocol}//${hostname}`,
    assets: `${protocol}//${hostname.replace(/^([a-z]+)\.i\./, '$1-assets.i.')}`,
    ui: `${protocol}//${hostname.replace(/^([a-z]+)\.i\./, '$1.')}`,
  };
}
