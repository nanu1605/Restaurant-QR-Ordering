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
 * refresh with its loop guard, the toasts, and loading in full where an answer is kept back.
 * Kept outside React, so the fetch observer and the error boundaries share it.
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

/**
 * The calls that leave the page (to a #hash, only scroll it), apart so a unit test can replace
 * them: jsdom has no navigation.
 */
export const pageExit = {
  load: (address: string) => location.assign(address),
  reload: () => location.reload(),
};

/** The Refresh button: a plain reload, never limited. */
export function refreshNow() {
  pageExit.reload();
}

function offerRefresh(title: string, description: string, label: string, closable = true) {
  toast(title, {
    id: TOAST_ID,
    description,
    // Until refreshed or closed; the next tap that meets the newer build brings it back.
    duration: Infinity,
    // Not where the answer is kept back (handlingFor): there the action stays pending and later
    // taps wait behind it, so a closed toast could not come back.
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
      setTimeout(() => pageExit.reload(), REFRESH_DELAY_MS);
      return next;
    }
    // Nothing could be written, so the loop guard can't work: no refresh by itself.
    next = 'stuck';
  }
  set({ notice: next, cause });
  if (source === 'boundary' || !online) return next;
  const t = NEW_VERSION_STRINGS[htmlLang()];
  const closable = refreshesByItself(location.pathname);
  // Where the answer is kept back, the tap that met the newer build reached nothing, and a control
  // that shows its change at once (dish availability, on duty, a reorder) looks as if it had.
  const kept = closable ? '' : ` ${t.notSaved}`;
  if (next === 'ready') {
    const description = `${t.ready.description}${kept} ${t.ready.copyFirst}`;
    offerRefresh(t.ready.title, description, t.refresh, closable);
  } else {
    const cart = isCartPage(location.pathname) ? ` ${t.cartSaved}` : '';
    offerRefresh(t.stuck.title, t.stuck.description + cart + kept, t.refresh, closable);
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

const withoutHash = (address: string) => address.split('#', 1)[0];

/**
 * A link with this attribute scrolls to a place on its own page itself, which a click of ours
 * would double: the website's menu sheet, after it has closed (site-mobile-nav.tsx).
 */
const SCROLLS_ITSELF = 'data-scrolls-itself';

/**
 * The address a click should load in full, or null to leave it alone: a plain click on a link to
 * another page of this site, or to a place on this one. Next.js's own move to a place waits
 * behind the action too, so nothing would scroll, but the browser follows the address itself:
 * it scrolls there and adds a history entry, with no reload. Not what the browser takes
 * elsewhere (a modifier key or another button, a target other than this tab, a download),
 * another site, this page without a place, or a link that scrolls itself.
 */
function linkToLoad(event: MouseEvent): string | null {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement) || event.defaultPrevented) return null;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return null;
  }
  if (link.hasAttribute('download') || !['', '_self'].includes(link.target.toLowerCase())) {
    return null;
  }
  if (link.origin !== location.origin) return null;
  if (withoutHash(link.href) !== withoutHash(location.href)) return link.href;
  return link.hash && !link.hasAttribute(SCROLLS_ITSELF) ? link.href : null;
}

function loadLinkInFull(event: MouseEvent) {
  const address = linkToLoad(event);
  if (address === null) return;
  // Before Next.js's Link sees the click: it does nothing for one that is prevented already
  // (onClick in app-dir/link.js).
  event.preventDefault();
  pageExit.load(address);
}

let loadingInFull = false;

/**
 * Once an answer is kept back the page is on an older build, and a caller inside a transition
 * holds the page's later ones, Next.js's navigations too, until its action ends, which it never
 * does (VPS-8). So from then on a plain click on a link loads its address in full (to a place on
 * this page, the browser scrolls there), and back or forward reloads the address the browser
 * moved to: the new build's page, as Next.js itself loads it on a deployment id mismatch
 * (VPS-7). Nothing a tap does is sent either, so <html> is marked for the stylesheet, which
 * stops taps on buttons and the other controls, though not on those that only open a menu or a
 * sheet (globals.css). Installed by the first kept answer and not before, so a page that never
 * meets a newer build is as it was.
 */
function loadInFullFromNow() {
  if (loadingInFull) return;
  loadingInFull = true;
  document.documentElement.dataset.newVersion = 'kept';
  const page = withoutHash(location.href);
  document.addEventListener('click', loadLinkInFull, true);
  // The browser has moved the URL already; a #hash alone is the same page, scrolled.
  window.addEventListener('popstate', () => {
    if (withoutHash(location.href) !== page) pageExit.reload();
  });
}

/**
 * Watches every server action's answer, from before the page hydrates. window.fetch is wrapped
 * once per tab; a dev hot reload only swaps the callback.
 */
export function watchForNewVersion() {
  const holder = window as Window & { __tableorderNewVersion?: () => Handling };
  const wrapped = holder.__tableorderNewVersion !== undefined;
  holder.__tableorderNewVersion = () => {
    const handling = handlingFor(newVersionFound('action'), location.pathname, navigator.onLine);
    if (handling === 'keep') loadInFullFromNow();
    return handling;
  };
  if (!wrapped) {
    window.fetch = watchFetch(window.fetch.bind(window), () => holder.__tableorderNewVersion!());
  }
}
