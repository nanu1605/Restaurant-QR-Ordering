import 'server-only';

import { z } from 'zod';

import { getServerEnv } from '@/lib/env.server';
import { SENTRY_OPTIONS } from '@/lib/sentry-options';

/**
 * What /super/system asks other services (docs/DECISIONS.md SA-89, SA-92):
 * Sentry's issues and each deployment's /api/health. Each answer is cached a
 * few minutes and times out fast; a failure shows on the page and is logged
 * as a warning (an error would itself go to Sentry).
 */

const TIMEOUT_MS = 3000;

export type SentryConfig = {
  token: string;
  org: string;
  project: string;
  baseUrl: string;
  environment: string;
};

/** The read-only token's settings, or null when it isn't set up. */
export function sentryConfig(): SentryConfig | null {
  const env = getServerEnv();
  if (!env.SENTRY_READ_TOKEN || !env.SENTRY_ORG || !env.SENTRY_PROJECT) return null;
  return {
    token: env.SENTRY_READ_TOKEN,
    org: env.SENTRY_ORG,
    project: env.SENTRY_PROJECT,
    baseUrl: env.SENTRY_API_URL,
    environment: SENTRY_OPTIONS.environment,
  };
}

const issueSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  title: z.string(),
  culprit: z.string().nullish(),
  count: z.coerce.number(),
  userCount: z.number().nullish(),
  lastSeen: z.string(),
  permalink: z.string(),
});
export type SentryIssue = z.infer<typeof issueSchema>;

// Sentry lists at most 100 a page; more reads as "100 or more".
const PAGE = 100;

export type SentryIssues =
  | { state: 'off' }
  | { state: 'error' }
  // A bad token, scope, organisation or project: settings to fix, not to wait out.
  | { state: 'refused'; status: number }
  | { state: 'ok'; count: number; more: boolean; top: SentryIssue[] };

/** Unresolved issues seen in the last 24 hours in this environment, most frequent first. */
export async function sentryIssues(
  config: SentryConfig | null = sentryConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<SentryIssues> {
  if (!config) return { state: 'off' };
  const query = new URLSearchParams({
    project: config.project,
    environment: config.environment,
    statsPeriod: '24h',
    query: 'is:unresolved',
    sort: 'freq',
    limit: String(PAGE),
  });
  const url = `${config.baseUrl.replace(/\/+$/, '')}/organizations/${encodeURIComponent(config.org)}/issues/?${query}`;
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'force-cache',
      next: { revalidate: 300 },
    });
    if (!response.ok) {
      console.warn(`[system] Sentry answered ${response.status}`);
      return response.status < 500
        ? { state: 'refused', status: response.status }
        : { state: 'error' };
    }
    const issues = z.array(issueSchema).parse(await response.json());
    return {
      state: 'ok',
      count: issues.length,
      more: issues.length >= PAGE,
      top: issues.slice(0, 5),
    };
  } catch (error) {
    console.warn('[system] Sentry could not be read', error);
    return { state: 'error' };
  }
}

export type Deployment = {
  name: string;
  url: string;
  state: 'ok' | 'error' | 'unreachable';
  // The HTTP status; 503 is /api/health's failed database check.
  status: number | null;
  version: string | null;
};

const healthSchema = z.object({ version: z.string().nullish() });

/** The commit each deployment runs, from its /api/health. */
export async function deploymentVersions(fetchImpl: typeof fetch = fetch): Promise<Deployment[]> {
  const env = getServerEnv();
  const targets = [
    { name: 'Production', url: env.PRODUCTION_APP_URL },
    { name: 'Staging', url: env.STAGING_APP_URL },
  ];
  return Promise.all(
    targets.map(async ({ name, url }): Promise<Deployment> => {
      try {
        const response = await fetchImpl(`${url.replace(/\/+$/, '')}/api/health`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: 'force-cache',
          next: { revalidate: 60 },
        });
        const body = healthSchema.safeParse(await response.json().catch(() => null));
        return {
          name,
          url,
          state: response.ok ? 'ok' : 'error',
          status: response.status,
          version: body.success ? (body.data.version ?? null) : null,
        };
      } catch (error) {
        console.warn(`[system] ${name} health could not be read`, error);
        return { name, url, state: 'unreachable', status: null, version: null };
      }
    }),
  );
}
