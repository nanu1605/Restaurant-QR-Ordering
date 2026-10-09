'use client';

import type { CaptureResult, PostHog } from 'posthog-js';
import { useEffect } from 'react';

import { posthogHosts } from '@/lib/posthog-hosts';

import { doNotTrack, rememberLanding, setVisitorId } from './attribution';

/** The website's own pages: the home page, its sections, sign-up and the policies. */
export function isWebsitePath(pathname: string) {
  return /^\/(features|pricing|demo|contact|signup(\/verify)?|terms|privacy|refund|shipping)?$/.test(
    pathname,
  );
}

/**
 * Only website pages are counted: a diner can reach the policies from the menu, and a visitor
 * can log in, by a client-side link, and the instance lives on after it. Full referrer URLs go
 * too (a menu address holds its table's code); the referring domain stays.
 */
function websiteOnly(event: CaptureResult | null): CaptureResult | null {
  if (!event || !isWebsitePath(window.location.pathname)) return null;
  delete event.properties.$referrer;
  delete event.properties.$initial_referrer;
  return event;
}

/**
 * PostHog on the website (docs/DECISIONS.md W-13), in its own instance so the panels' (P10-4)
 * is never shared: nothing kept in cookies or storage, so a visit lasts until the page is
 * reloaded and no consent banner is needed. No automatic click capture (with everything masked
 * it can't tell buttons apart): the calls to action send `cta_clicked` instead. No recordings,
 * surveys, tours or chat.
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
  before_send: websiteOnly,
} as const;

let site: PostHog | undefined;

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
        site ??= posthog.init(key, SITE_POSTHOG_OPTIONS, 'website');
        if (!site) return;
        const instance = site;
        setVisitorId(instance.get_distinct_id());
        const onClick = (event: MouseEvent) => {
          const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
          if (!(link instanceof HTMLAnchorElement)) return;
          const click = ctaClick(link.href, link.closest<HTMLElement>('[data-cta]')?.dataset.cta);
          if (click) instance.capture('cta_clicked', click);
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
