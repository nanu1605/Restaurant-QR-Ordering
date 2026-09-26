import { describe, expect, it } from 'vitest';

import { posthogHosts } from '@/lib/posthog-hosts';

describe('PostHog hosts for the policy (docs/DECISIONS.md P10-4)', () => {
  it('maps a region to its API and assets hosts', () => {
    expect(posthogHosts('https://eu.i.posthog.com')).toEqual({
      api: 'https://eu.i.posthog.com',
      assets: 'https://eu-assets.i.posthog.com',
    });
    expect(posthogHosts()).toEqual({
      api: 'https://us.i.posthog.com',
      assets: 'https://us-assets.i.posthog.com',
    });
  });
});
