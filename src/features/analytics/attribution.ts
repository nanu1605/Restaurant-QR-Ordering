/**
 * Where a website visit came from (docs/DECISIONS.md W-13): the campaign tags of the link the
 * visitor landed on and the site that sent them. Kept in this module only (no cookie or
 * storage), so it lasts for the visit, and sent with the demo-request and sign-up forms.
 */

export const SOURCE_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'referrer'] as const;
export type Source = Partial<Record<(typeof SOURCE_KEYS)[number], string>>;

/** The tags of a landing URL, and the referring site's domain when it isn't this site. */
export function landingSource(url: string, referrer: string): Source {
  const landing = new URL(url);
  const source: Source = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign'] as const) {
    const value = landing.searchParams.get(key)?.trim().slice(0, 100);
    if (value) source[key] = value;
  }
  const from = URL.canParse(referrer) ? new URL(referrer).hostname : '';
  if (from && from !== landing.hostname) source.referrer = from;
  return source;
}

let landing: Source | undefined;
let visitorId: string | undefined;

/** Called on every website page; only the first page of the visit counts. */
export function rememberLanding() {
  landing ??= landingSource(window.location.href, document.referrer);
}

/** The visit's anonymous PostHog id, so the server's events join the visit's. */
export function setVisitorId(id: string) {
  visitorId = id;
}

/** Do Not Track or Global Privacy Control: nothing about the visit goes to PostHog. */
export function doNotTrack() {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.doNotTrack === '1' || nav.globalPrivacyControl === true;
}

/** The hidden `attribution` field the forms send (read by parseAttribution). */
export function attributionField(formData: FormData) {
  formData.set(
    'attribution',
    JSON.stringify({ source: landing ?? {}, visitor: visitorId, dnt: doNotTrack() }),
  );
  return formData;
}
