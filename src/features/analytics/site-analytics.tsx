'use client';

import { useEffect } from 'react';

import { posthogHosts } from '@/lib/posthog-hosts';

import { doNotTrack, rememberLanding, setVisitorId } from './attribution';

/**
 * PostHog on the website (docs/DECISIONS.md W-13): nothing kept in cookies or storage, so a
 * visit lasts until the page is reloaded and no consent banner is needed. No automatic click
 * capture (with everything masked it can't tell buttons apart): the calls to action send
 * `cta_clicked` instead. No recordings, surveys, tours or chat.
 */
export const SITE_POSTHOG_OPTIONS = {
  api_host: posthogHosts(process.env.NEXT_PUBLIC_POSTHOG_HOST || undefined).api,
  persistence: 'memory',
  person_profiles: 'identified_only',
  capture_pageview: 'history_change',
  autocapture: false,
  mask_all_text: true,
  mask_all_element_attributes: true,
  // Ad-click ids (gclid, fbclid, …) in page addresses.
  mask_personal_data_properties: true,
  respect_dnt: true,
  disable_session_recording: true,
  disable_surveys: true,
  disable_product_tours: true,
  disable_conversations: true,
  // ?__posthog_debug=true would otherwise turn on a debug flag kept in localStorage.
  debug: false,
} as const;

/** A click on a link to sign-up or a demo request, as a `cta_clicked` event; else null. */
export function ctaClick(href: string, location: string | undefined) {
  const url = new URL(href);
  const target =
    url.pathname === '/signup' ? 'signup' : url.pathname === '/contact' ? 'contact' : null;
  if (!target) return null;
  return {
    target,
    location: location ?? 'page',
    plan: url.searchParams.get('plan') ?? undefined,
    cycle: url.searchParams.get('cycle') ?? undefined,
  };
}

/**
 * Notes where the visit came from on every website page, and counts the visit once the page
 * is idle when PostHog has a key and the visitor hasn't asked not to be tracked.
 */
export function SiteAnalytics() {
  useEffect(() => {
    rememberLanding();
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key || doNotTrack()) return;

    let stopped = false;
    let stopListening = () => {};
    const load = () =>
      void import('posthog-js').then(({ default: posthog }) => {
        if (stopped) return;
        if (!posthog.__loaded) posthog.init(key, SITE_POSTHOG_OPTIONS);
        setVisitorId(posthog.get_distinct_id());
        const onClick = (event: MouseEvent) => {
          const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
          if (!(link instanceof HTMLAnchorElement)) return;
          const click = ctaClick(link.href, link.closest<HTMLElement>('[data-cta]')?.dataset.cta);
          if (click) posthog.capture('cta_clicked', click);
        };
        document.addEventListener('click', onClick, { capture: true });
        stopListening = () => document.removeEventListener('click', onClick, { capture: true });
      });
    let cancel: () => void;
    if ('requestIdleCallback' in window) {
      const handle = window.requestIdleCallback(load, { timeout: 3000 });
      cancel = () => window.cancelIdleCallback(handle);
    } else {
      const handle = setTimeout(load, 1000);
      cancel = () => clearTimeout(handle);
    }
    return () => {
      stopped = true;
      cancel();
      stopListening();
    };
  }, []);
  return null;
}
