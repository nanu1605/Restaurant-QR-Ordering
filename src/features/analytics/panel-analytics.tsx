'use client';

import { useEffect } from 'react';

import { posthogHosts } from './posthog-hosts';

type PanelAnalyticsProps = {
  /** The member (or platform admin) using the panel: an id, never a name or email. */
  userId: string;
  role: string;
  restaurantId: string | null;
};

/**
 * Product analytics for the staff, admin and super-admin panels (spec §17,
 * docs/DECISIONS.md P10-4). Diners' phones never load it. Off without a key;
 * PostHog's script loads after the page, and on-screen text is never sent.
 */
export function PanelAnalytics({ userId, role, restaurantId }: PanelAnalyticsProps) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;
    void import('posthog-js').then(({ default: posthog }) => {
      if (!posthog.__loaded) {
        posthog.init(key, {
          api_host: '/ingest',
          ui_host: posthogHosts(process.env.NEXT_PUBLIC_POSTHOG_HOST).ui,
          person_profiles: 'identified_only',
          capture_pageview: 'history_change',
          mask_all_text: true,
          disable_session_recording: true,
          disable_surveys: true,
        });
      }
      // Another login on this device: start a new person, not a merged one.
      if (posthog.get_distinct_id() !== userId) {
        posthog.reset();
        posthog.identify(userId, { role, restaurant_id: restaurantId });
      }
    });
  }, [userId, role, restaurantId]);
  return null;
}
