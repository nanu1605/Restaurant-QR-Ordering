import { describe, expect, it } from 'vitest';

import { posthogHosts } from '@/features/analytics/posthog-hosts';

describe('PostHog hosts behind /ingest (docs/DECISIONS.md P10-4)', () => {
  it('maps a region to its API, assets and app hosts', () => {
    expect(posthogHosts('https://eu.i.posthog.com')).toEqual({
      api: 'https://eu.i.posthog.com',
      assets: 'https://eu-assets.i.posthog.com',
      ui: 'https://eu.posthog.com',
    });
    expect(posthogHosts()).toEqual({
      api: 'https://us.i.posthog.com',
      assets: 'https://us-assets.i.posthog.com',
      ui: 'https://us.posthog.com',
    });
  });
});
