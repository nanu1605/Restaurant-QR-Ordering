import 'server-only';

import { getPublicEnv } from '@/lib/env';
import { posthogHosts } from '@/lib/posthog-hosts';

import { SOURCE_KEYS, type Source } from './attribution';

export type Attribution = { source: Source; visitor?: string; dnt: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** The forms' hidden `attribution` field (attributionField), keeping only what is expected. */
export function parseAttribution(raw: FormDataEntryValue | null): Attribution {
  let data: unknown = null;
  try {
    data = JSON.parse(String(raw ?? ''));
  } catch {
    // Missing or not JSON: nothing is known about the visit.
  }
  const given = record(record(data).source);
  const source: Source = {};
  for (const key of SOURCE_KEYS) {
    const tag = given[key];
    if (typeof tag === 'string' && tag.trim()) source[key] = tag.trim().slice(0, 100);
  }
  const { visitor, dnt } = record(data);
  return {
    source,
    visitor: typeof visitor === 'string' && UUID.test(visitor) ? visitor : undefined,
    dnt: dnt === true,
  };
}

/**
 * One conversion event sent to PostHog by the server, where ad blockers can't drop it
 * (docs/DECISIONS.md W-13). Anonymous (no person profile, no location from the server's
 * address) and never a name, email, phone or message. Off without a key or when the visitor
 * asked not to be tracked; a failure is only logged.
 */
export async function captureServerEvent(
  event: string,
  attribution: Attribution,
  properties: Record<string, string | null>,
  fetchImpl: typeof fetch = fetch,
) {
  const env = getPublicEnv();
  if (!env.NEXT_PUBLIC_POSTHOG_KEY || attribution.dnt) return;
  const { referrer, ...tags } = attribution.source;
  try {
    const response = await fetchImpl(`${posthogHosts(env.NEXT_PUBLIC_POSTHOG_HOST).api}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.NEXT_PUBLIC_POSTHOG_KEY,
        batch: [
          {
            event,
            distinct_id: attribution.visitor ?? crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            properties: {
              ...tags,
              ...properties,
              $referring_domain: referrer,
              // Staging and production share a project: filter by host.
              $host: new URL(env.NEXT_PUBLIC_APP_URL).host,
              $process_person_profile: false,
              $geoip_disable: true,
              $lib: 'menumesh-server',
            },
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) console.warn(`[analytics] ${event} not sent: HTTP ${response.status}`);
  } catch (error) {
    console.warn(`[analytics] ${event} not sent`, error);
  }
}
