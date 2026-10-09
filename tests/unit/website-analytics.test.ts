import type { CaptureResult } from 'posthog-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attributionField,
  describeSource,
  landingSource,
  setVisitorId,
} from '@/features/analytics/attribution';
import { captureServerEvent, parseAttribution } from '@/features/analytics/server';
import { ctaClick, isWebsitePath, SITE_POSTHOG_OPTIONS } from '@/features/analytics/site-analytics';

// Website analytics and where a visit came from (docs/DECISIONS.md W-13).

const env = vi.hoisted(() => ({
  NEXT_PUBLIC_APP_URL: 'https://menumesh.in',
  NEXT_PUBLIC_POSTHOG_KEY: 'phc_test' as string | undefined,
  NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com',
}));
vi.mock('@/lib/env', () => ({ getPublicEnv: () => env }));

const VISITOR = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('where a visit came from', () => {
  it('keeps the campaign tags of the landing link and an outside referrer', () => {
    expect(
      landingSource(
        'https://menumesh.in/pricing?utm_source=+newsletter+&utm_medium=email&utm_campaign=launch&utm_term=x',
        'https://www.google.com/search?q=menumesh',
      ),
    ).toEqual({
      utm_source: 'newsletter',
      utm_medium: 'email',
      utm_campaign: 'launch',
      referrer: 'www.google.com',
    });
    expect(landingSource('https://menumesh.in/?utm_source=' + 'x'.repeat(150), '')).toEqual({
      utm_source: 'x'.repeat(100),
    });
  });

  it('ignores this site as a referrer, and referrers that aren’t addresses', () => {
    expect(landingSource('https://menumesh.in/', 'https://menumesh.in/features')).toEqual({});
    expect(landingSource('https://menumesh.in/?utm_source=', 'not a url')).toEqual({});
  });

  it('describes a stored source for the platform team', () => {
    expect(
      describeSource({
        utm_source: 'newsletter',
        utm_medium: 'email',
        utm_campaign: 'launch',
        referrer: 'google.com',
      }),
    ).toEqual(['newsletter / email', 'Campaign: launch', 'From google.com']);
    expect(describeSource({ referrer: 'google.com' })).toEqual(['From google.com']);
    expect(describeSource(null)).toEqual([]);
  });

  it('reaches the server through the forms’ hidden field', () => {
    setVisitorId(VISITOR);
    const formData = attributionField(new FormData());
    expect(parseAttribution(formData.get('attribution'))).toEqual({
      source: {},
      visitor: VISITOR,
      dnt: false,
    });
  });

  it('keeps only what is expected from the hidden field', () => {
    const raw = JSON.stringify({
      source: { utm_source: '  ads ', utm_medium: 3, utm_content: 'x', referrer: 'r'.repeat(120) },
      visitor: 'not-an-id',
      dnt: 'yes',
      name: 'Asha',
    });
    expect(parseAttribution(raw)).toEqual({
      source: { utm_source: 'ads', referrer: 'r'.repeat(100) },
      visitor: undefined,
      dnt: false,
    });
    for (const junk of [null, '', 'not json', '[]', '"text"', '{"source": "x"}']) {
      expect(parseAttribution(junk)).toEqual({ source: {}, visitor: undefined, dnt: false });
    }
    expect(parseAttribution(JSON.stringify({ dnt: true })).dnt).toBe(true);
  });
});

describe('server events', () => {
  afterEach(() => {
    env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
  });

  const ok = () => vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));

  it('sends one anonymous event to the region’s batch endpoint', async () => {
    const fetchImpl = ok();
    await captureServerEvent(
      'signup_started',
      { source: { utm_source: 'ads', referrer: 'google.com' }, visitor: VISITOR, dnt: false },
      { plan: 'growth', cycle: 'monthly' },
      fetchImpl,
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://eu.i.posthog.com/batch/');
    const body = JSON.parse(String(init?.body));
    expect(body.api_key).toBe('phc_test');
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0]).toMatchObject({ event: 'signup_started', distinct_id: VISITOR });
    expect(body.batch[0].properties).toEqual({
      utm_source: 'ads',
      plan: 'growth',
      cycle: 'monthly',
      $referring_domain: 'google.com',
      $host: 'menumesh.in',
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: 'menumesh-server',
    });
  });

  it('gives a visit without an id a fresh one', async () => {
    const fetchImpl = ok();
    await captureServerEvent(
      'lead_submitted',
      { source: {}, dnt: false },
      { plan: null },
      fetchImpl,
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.batch[0].distinct_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends nothing without a key or when the visitor asked not to be tracked', async () => {
    const fetchImpl = ok();
    await captureServerEvent('lead_submitted', { source: {}, dnt: true }, {}, fetchImpl);
    env.NEXT_PUBLIC_POSTHOG_KEY = undefined;
    await captureServerEvent('lead_submitted', { source: {}, dnt: false }, {}, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('only logs a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = vi.fn<typeof fetch>(async () => new Response('', { status: 401 }));
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const attribution = { source: {}, dnt: false };
    await expect(captureServerEvent('x', attribution, {}, refused)).resolves.toBeUndefined();
    await expect(captureServerEvent('x', attribution, {}, offline)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('PostHog on the website', () => {
  it('keeps nothing on the device and sends no text, recordings or ad-click ids', () => {
    expect(SITE_POSTHOG_OPTIONS).toMatchObject({
      persistence: 'memory',
      person_profiles: 'identified_only',
      autocapture: false,
      mask_all_text: true,
      mask_all_element_attributes: true,
      mask_personal_data_properties: true,
      respect_dnt: true,
      disable_session_recording: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      debug: false,
    });
  });

  it('knows the website’s own pages', () => {
    for (const path of [
      '/',
      '/features',
      '/pricing',
      '/demo',
      '/contact',
      '/signup',
      '/signup/verify',
      '/terms',
      '/privacy',
      '/refund',
      '/shipping',
    ]) {
      expect(isWebsitePath(path), path).toBe(true);
    }
    for (const path of [
      '/t/DEMO0000TABLE001',
      '/admin',
      '/staff',
      '/super',
      '/login',
      '/signups',
      '/privacy/x',
      '/no-such-page',
    ]) {
      expect(isWebsitePath(path), path).toBe(false);
    }
  });

  it('sends nothing from other pages, and no full referrer address', () => {
    const event = (): CaptureResult => ({
      uuid: 'u',
      event: '$pageview',
      properties: {
        $referrer: 'https://menumesh.in/t/DEMO0000TABLE001',
        $initial_referrer: 'https://menumesh.in/t/DEMO0000TABLE001',
        $referring_domain: 'menumesh.in',
      },
    });
    try {
      // A diner back on the menu after reading the policy, with the instance still loaded.
      vi.stubGlobal('window', { location: { pathname: '/t/DEMO0000TABLE001' } });
      expect(SITE_POSTHOG_OPTIONS.before_send(event())).toBeNull();
      vi.stubGlobal('window', { location: { pathname: '/privacy' } });
      expect(SITE_POSTHOG_OPTIONS.before_send(event())?.properties).toEqual({
        $referring_domain: 'menumesh.in',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('counts clicks on links to sign-up or a demo request, with where they sit', () => {
    expect(ctaClick('https://menumesh.in/signup?plan=growth&cycle=yearly', 'plan_card')).toEqual({
      target: 'signup',
      location: 'plan_card',
      plan: 'growth',
      cycle: 'yearly',
    });
    expect(ctaClick('https://menumesh.in/contact', undefined)).toEqual({
      target: 'contact',
      location: 'page',
      plan: undefined,
      cycle: undefined,
    });
    expect(ctaClick('https://menumesh.in/login', 'header')).toBeNull();
    expect(ctaClick('https://menumesh.in/#how', 'hero')).toBeNull();
  });
});
