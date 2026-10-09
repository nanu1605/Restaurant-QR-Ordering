'use client';

import { useEffect } from 'react';

import { posthogHosts } from '@/lib/posthog-hosts';

import { isWebsitePath } from './site-analytics';

type PanelAnalyticsProps = {
  /** The member (or platform admin) using the panel: an id, never a name or email. */
  userId: string;
  role: string;
  restaurantId: string | null;
};

/**
 * Product analytics for the staff, admin and super-admin panels (spec §17,
 * docs/DECISIONS.md P10-4). Diners' phones never load it. Off without a key;
 * PostHog's script loads after the page, and no on-screen text or attribute
 * (waiters' names are in button labels) is sent.
 */
export function PanelAnalytics({ userId, role, restaurantId }: PanelAnalyticsProps) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;
    void import('posthog-js').then(({ default: posthog }) => {
      if (!posthog.__loaded) {
        posthog.init(key, {
          // Straight to PostHog: a relay on our origin would forward staff session cookies.
          api_host: posthogHosts(process.env.NEXT_PUBLIC_POSTHOG_HOST || undefined).api,
          person_profiles: 'identified_only',
          capture_pageview: 'history_change',
          mask_all_text: true,
          mask_all_element_attributes: true,
          disable_session_recording: true,
          disable_surveys: true,
          // The website has its own instance, without cookies (W-13): nothing from its pages
          // here, after a client-side move from a panel.
          before_send: (event) => (event && isWebsitePath(window.location.pathname) ? null : event),
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
