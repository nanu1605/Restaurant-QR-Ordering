'use client';

import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';

import type { Lang } from '@/features/ordering/strings';

import {
  type Cause,
  currentDeploymentId,
  decide,
  type Handling,
  handlingFor,
  lastRefresh,
  type Notice,
  REFRESH_DELAY_MS,
  refreshesByItself,
  rememberRefresh,
  type Source,
  takeRefreshNotice,
  watchFetch,
} from './stale';
import { NEW_VERSION_STRINGS } from './strings';

/**
 * What a tab does about a newer build (docs/DECISIONS.md VPS-8): the notice it shows, the
 * refresh with its loop guard, and the toasts. Kept outside React, so the fetch observer and
 * the error boundaries share it.
 */

type State = { notice: Notice; cause: Cause };

const NONE: State = { notice: 'none', cause: 'version' };
let state = NONE;
const listeners = new Set<() => void>();

function set(next: State) {
  if (next.notice === state.notice && next.cause === state.cause) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The tab's notice; none while server rendering. */
export function useNewVersionNotice(): State {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => NONE,
  );
}

const htmlLang = (): Lang => (document.documentElement.lang === 'hi' ? 'hi' : 'en');
const unchanging = () => () => {};

/**
 * The page's language from <html lang>, which the root layout, the worker panel and the
 * website's language switch keep current; English while server rendering.
 */
export function usePageLang(): Lang {
  return useSyncExternalStore(unchanging, htmlLang, () => 'en');
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // Site data blocked.
    return null;
  }
}

const TOAST_ID = 'new-version';

/** The guest's cart page: there the notice says the cart is kept (it is in localStorage). */
export const isCartPage = (pathname: string) => /^\/t\/[^/]+\/cart\/?$/.test(pathname);

/** The Refresh button: a plain reload, never limited. */
export function refreshNow() {
  location.reload();
}

function offerRefresh(title: string, description: string, label: string, closable = true) {
  toast(title, {
    id: TOAST_ID,
    description,
    // Until refreshed or closed; the next tap that meets the newer build brings it back.
    duration: Infinity,
    // Not where the answer is kept back (handlingFor): there the action stays pending, and later
    // taps and links wait behind it, so a closed toast could not come back.
    closeButton: closable,
    dismissible: closable,
    action: { label, onClick: refreshNow },
  });
}

/**
 * A page from an older build, noticed by the fetch observer or an error boundary. It refreshes,
 * or a toast offers Refresh: a boundary's card is its own message, and offline nothing is
 * claimed. Returns what the page now does.
 */
export function newVersionFound(source: Source, cause: Cause = 'version'): Exclude<Notice, 'none'> {
  const store = sessionStore();
  const now = Date.now();
  const online = navigator.onLine;
  let next = decide({
    source,
    current: state.notice,
    pathname: location.pathname,
    online,
    lastRefreshAt: lastRefresh(store)?.at ?? null,
    canRemember: store !== null,
    now,
  });
  if (next === 'refreshing') {
    if (state.notice === 'refreshing') return next;
    if (rememberRefresh(store, { at: now, from: currentDeploymentId(), cause })) {
      set({ notice: 'refreshing', cause });
      toast.dismiss(TOAST_ID);
      setTimeout(() => location.reload(), REFRESH_DELAY_MS);
      return next;
    }
    // Nothing could be written, so the loop guard can't work: no refresh by itself.
    next = 'stuck';
  }
  set({ notice: next, cause });
  if (source === 'boundary' || !online) return next;
  const t = NEW_VERSION_STRINGS[htmlLang()];
  const closable = refreshesByItself(location.pathname);
  if (next === 'ready') {
    offerRefresh(t.ready.title, `${t.ready.description} ${t.ready.copyFirst}`, t.refresh, closable);
  } else {
    const cart = isCartPage(location.pathname) ? ` ${t.cartSaved}` : '';
    offerRefresh(t.stuck.title, t.stuck.description + cart, t.refresh, closable);
  }
  return next;
}

/** On the page a refresh opened, once: it worked, or the same build came back. */
export function showRefreshedNotice() {
  const notice = takeRefreshNotice(sessionStore(), Date.now(), currentDeploymentId());
  if (!notice) return;
  const t = NEW_VERSION_STRINGS[htmlLang()];
  const cart = isCartPage(location.pathname) ? ` ${t.cartSaved}` : '';
  if (notice === 'stuck') {
    set({ notice: 'stuck', cause: 'version' });
    offerRefresh(t.stuck.title, t.stuck.description + cart, t.refresh);
    return;
  }
  // Long enough to read both sentences.
  toast.success(t.updated.title, {
    id: TOAST_ID,
    description: t.updated.description + cart,
    duration: 10_000,
  });
}

/**
 * Watches every server action's answer, from before the page hydrates. window.fetch is wrapped
 * once per tab; a dev hot reload only swaps the callback.
 */
export function watchForNewVersion() {
  const holder = window as Window & { __tableorderNewVersion?: () => Handling };
  const wrapped = holder.__tableorderNewVersion !== undefined;
  holder.__tableorderNewVersion = () =>
    handlingFor(newVersionFound('action'), location.pathname, navigator.onLine);
  if (!wrapped) {
    window.fetch = watchFetch(window.fetch.bind(window), () => holder.__tableorderNewVersion!());
  }
}
