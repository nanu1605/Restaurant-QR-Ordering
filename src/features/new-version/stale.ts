/**
 * A page from an older build (docs/DECISIONS.md VPS-7). After a deploy the server no longer
 * knows that page's server actions: Next.js answers 409 with `x-nextjs-action-not-found: 1`
 * and its router throws UnrecognizedActionError. A script the page loads later can fail too
 * (ChunkLoadError), though that is more often the connection than a deploy. No imports: this
 * ships on every page, and server code may import it.
 */

/** Next.js's header (app-router-headers.js); a unit test pins it. */
export const ACTION_NOT_FOUND_HEADER = 'x-nextjs-action-not-found';
/** sessionStorage, per tab: when the tab last refreshed by itself, and from which build. */
export const REFRESH_KEY = 'tableorder:new-version';
/** At most one refresh by itself per tab in this time, so a broken deploy can't loop a page. */
export const REFRESH_COOLDOWN_MS = 2 * 60_000;
/** The page a refresh opened says so within this time of it. */
export const NOTICE_MS = 30_000;
/** How long an older build's answer is held while the page reloads. */
export const HOLD_MS = 10_000;
/** Lets the "Refreshing…" screen show before the page goes. */
export const REFRESH_DELAY_MS = 300;

/** Nothing yet, refreshing by itself, offering Refresh, or offering it after a refresh didn't help. */
export type Notice = 'none' | 'refreshing' | 'ready' | 'stuck';
/** A newer build for sure (an action it doesn't have), or a script that didn't load. */
export type Cause = 'version' | 'chunk';
/** The fetch observer (an action's answer) or an error boundary. */
export type Source = 'action' | 'boundary';

/**
 * Next.js's error for an action this build doesn't have. Matched by the name its constructor
 * sets: the class comes from next/navigation, which throws in server code, and it can load twice.
 */
export function isUnrecognizedAction(error: unknown): boolean {
  return error instanceof Error && error.name === 'UnrecognizedActionError';
}

// Turbopack's runtime, then webpack's.
const CHUNK_MESSAGE = /^(?:Failed to load chunk |Loading (?:CSS )?chunk \S+ failed)/;

export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === 'ChunkLoadError' || (typeof message === 'string' && CHUNK_MESSAGE.test(message));
}

/**
 * Why an error boundary refreshes, if it does. Call sites check isUnrecognizedAction only: that
 * error comes after the fetch observer has shown its notice, a missing script doesn't.
 */
export function staleCause(error: unknown): Cause | null {
  if (isUnrecognizedAction(error)) return 'version';
  return isChunkLoadError(error) ? 'chunk' : null;
}

export const isStaleActionResponse = (response: Response) =>
  response.headers.get(ACTION_NOT_FOUND_HEADER) === '1';

/** This page's build, from <html data-dpl-id> as Next.js reads it; unset locally and in CI. */
export function currentDeploymentId(): string | null {
  return (globalThis as { NEXT_DEPLOYMENT_ID?: string }).NEXT_DEPLOYMENT_ID || null;
}

/**
 * The live screens: what matters there is already on the device (the cart in localStorage,
 * dish moves in the P9-5 journal), so they refresh by themselves.
 */
export const refreshesByItself = (pathname: string) =>
  /^\/(?:staff(?:\/|$)|t\/|admin\/live(?:\/|$))/.test(pathname);

type Situation = {
  source: Source;
  current: Notice;
  pathname: string;
  online: boolean;
  lastRefreshAt: number | null;
  /** sessionStorage works, so the loop guard does. */
  canRemember: boolean;
  now: number;
};

/**
 * What a page from an older build does (docs/DECISIONS.md VPS-8). The live screens, and a page
 * an error boundary has already replaced, refresh by themselves: online, where the loop guard
 * can remember it, and once per tab in REFRESH_COOLDOWN_MS; otherwise they are stuck. Other
 * pages offer Refresh, so what was typed can be copied first.
 */
export function decide({
  source,
  current,
  pathname,
  online,
  lastRefreshAt,
  canRemember,
  now,
}: Situation): Exclude<Notice, 'none'> {
  if (current === 'refreshing') return 'refreshing';
  const recent = lastRefreshAt !== null && now - lastRefreshAt < REFRESH_COOLDOWN_MS;
  if (source === 'action' && !refreshesByItself(pathname)) {
    return recent || current === 'stuck' ? 'stuck' : 'ready';
  }
  return online && canRemember && !recent && current !== 'stuck' ? 'refreshing' : 'stuck';
}

type SessionStore = Pick<Storage, 'getItem' | 'setItem'>;
/** A refresh the tab made by itself. */
type Refresh = { at: number; from: string | null; cause: Cause; noticed: boolean };

function isRefresh(value: unknown): value is Refresh {
  if (typeof value !== 'object' || value === null) return false;
  const { at, from, cause, noticed } = value as Record<string, unknown>;
  return (
    typeof at === 'number' &&
    (from === null || typeof from === 'string') &&
    (cause === 'version' || cause === 'chunk') &&
    typeof noticed === 'boolean'
  );
}

/** The tab's last refresh by itself; a damaged record counts as none. */
export function lastRefresh(store: SessionStore | null): Refresh | null {
  try {
    const value: unknown = JSON.parse(store?.getItem(REFRESH_KEY) ?? 'null');
    return isRefresh(value) ? value : null;
  } catch {
    return null;
  }
}

/** False when the record can't be written: the page must not then refresh by itself. */
export function rememberRefresh(
  store: SessionStore | null,
  refresh: Omit<Refresh, 'noticed'>,
): boolean {
  if (!store) return false;
  try {
    store.setItem(REFRESH_KEY, JSON.stringify({ ...refresh, noticed: false }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Once, on the page a refresh opened: 'updated', or 'stuck' when the same build came back (a
 * cached page). A refresh after a script that didn't load needs no word.
 */
export function takeRefreshNotice(
  store: SessionStore | null,
  now: number,
  current: string | null,
): 'updated' | 'stuck' | null {
  const refresh = lastRefresh(store);
  if (!refresh || refresh.noticed || now - refresh.at >= NOTICE_MS) return null;
  try {
    store?.setItem(REFRESH_KEY, JSON.stringify({ ...refresh, noticed: true }));
  } catch {
    // Readable but full: the next load within NOTICE_MS says it again.
  }
  if (refresh.cause === 'chunk') return null;
  return refresh.from !== null && refresh.from === current ? 'stuck' : 'updated';
}

/**
 * window.fetch that notices an older build's answer. While the page refreshes onto the new
 * build it holds that answer (up to HOLD_MS), so the caller shows no error and a queued dish
 * move stays queued. It never catches: an aborted request stays a TypeError.
 */
export function watchFetch(fetchImpl: typeof fetch, onStale: () => Notice): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!isStaleActionResponse(response) || onStale() !== 'refreshing') return response;
    return new Promise<Response>((resolve) => setTimeout(() => resolve(response), HOLD_MS));
  };
}
