// @vitest-environment jsdom
import { readFileSync } from 'node:fs';

import { NEXT_ACTION_NOT_FOUND_HEADER } from 'next/dist/client/components/app-router-headers';
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACTION_NOT_FOUND_HEADER,
  decide,
  type Handling,
  handlingFor,
  HOLD_MS,
  isStaleActionResponse,
  isUnrecognizedAction,
  lastRefresh,
  type Notice,
  NOTICE_MS,
  REFRESH_KEY,
  refreshesByItself,
  rememberRefresh,
  staleCause,
  takeRefreshNotice,
  watchFetch,
} from '@/features/new-version/stale';
import { NEW_VERSION_STRINGS } from '@/features/new-version/strings';
import { APP_NAME } from '@/lib/config';

// Pages from an older build (docs/DECISIONS.md VPS-7, VPS-8, VPS-12).

// One mock for every fresh import of the notice module (vi.resetModules below).
const toast = vi.hoisted(() => Object.assign(vi.fn(), { dismiss: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const chunkError = () =>
  Object.assign(new Error('Failed to load chunk /_next/static/chunks/0ab.js from module 42'), {
    name: 'ChunkLoadError',
  });

/** What Next.js answers an action it doesn't have. */
const staleResponse = (status = 409) =>
  new Response('Server Action unavailable.', {
    status,
    headers: { 'content-type': 'text/plain', [NEXT_ACTION_NOT_FOUND_HEADER]: '1' },
  });

describe('how an older build shows itself', () => {
  it('Next.js’s error for an action it doesn’t have, by its own class', () => {
    const error = new UnrecognizedActionError('Server Action "7f0a" was not found on the server.');
    expect(isUnrecognizedAction(error)).toBe(true);
    expect(staleCause(error)).toBe('version');
  });

  it('a script that didn’t load, from Turbopack or webpack', () => {
    expect(staleCause(chunkError())).toBe('chunk');
    expect(staleCause(new Error('Loading chunk 12 failed.'))).toBe('chunk');
    expect(staleCause(new Error('Loading CSS chunk 7 failed.'))).toBe('chunk');
    expect(isUnrecognizedAction(chunkError())).toBe(false);
  });

  it('not other errors', () => {
    for (const error of [
      new TypeError('Failed to fetch'),
      new Error('An unexpected response was received from the server.'),
      new Error('The table is busy.'),
      'UnrecognizedActionError',
      null,
      undefined,
    ]) {
      expect(staleCause(error), String(error)).toBeNull();
      expect(isUnrecognizedAction(error), String(error)).toBe(false);
    }
  });

  it('Next.js’s answer, by its own header', () => {
    expect(ACTION_NOT_FOUND_HEADER).toBe(NEXT_ACTION_NOT_FOUND_HEADER);
    expect(isStaleActionResponse(staleResponse())).toBe(true);
    expect(isStaleActionResponse(staleResponse(400))).toBe(true);
    expect(isStaleActionResponse(new Response('', { status: 409 }))).toBe(false);
    const zero = new Response('', { status: 409, headers: { [ACTION_NOT_FOUND_HEADER]: '0' } });
    expect(isStaleActionResponse(zero)).toBe(false);
  });

  it('imports nothing, so server code can use it (next/navigation throws there)', () => {
    expect(readFileSync('src/features/new-version/stale.ts', 'utf8')).not.toMatch(/^import /m);
  });
});

describe('what a page from an older build does', () => {
  it('the live screens refresh by themselves', () => {
    for (const path of ['/staff', '/staff/kitchen', '/admin/live', '/t/AbC123', '/t/AbC123/cart']) {
      expect(refreshesByItself(path), path).toBe(true);
    }
    for (const path of [
      '/admin',
      '/admin/menu',
      '/admin/livestock',
      '/super/restaurants',
      '/',
      '/hi/signup',
      '/login',
      '/t',
      '/staffroom',
    ]) {
      expect(refreshesByItself(path), path).toBe(false);
    }
  });

  const NOW = 1_000_000_000;
  const BOARD = {
    source: 'action',
    current: 'none',
    pathname: '/staff',
    online: true,
    lastRefreshAt: null,
    canRemember: true,
    now: NOW,
  } as const;

  it.each<[string, Partial<Parameters<typeof decide>[0]>, Notice]>([
    ['an action on the board refreshes', {}, 'refreshing'],
    ['an action in the admin panel offers Refresh', { pathname: '/admin/menu' }, 'ready'],
    [
      'a boundary in the admin panel refreshes',
      { source: 'boundary', pathname: '/admin/menu' },
      'refreshing',
    ],
    ['a refresh 60 s ago means stuck', { lastRefreshAt: NOW - 60_000 }, 'stuck'],
    ['a refresh 3 min ago no longer counts', { lastRefreshAt: NOW - 3 * 60_000 }, 'refreshing'],
    [
      'the admin panel after a refresh 60 s ago is stuck',
      { pathname: '/admin/menu', lastRefreshAt: NOW - 60_000 },
      'stuck',
    ],
    ['without storage it is stuck', { canRemember: false }, 'stuck'],
    ['offline it is stuck', { online: false }, 'stuck'],
    [
      'offline, the admin panel still offers Refresh',
      { pathname: '/admin/menu', online: false },
      'ready',
    ],
    [
      'while refreshing it keeps refreshing',
      { current: 'refreshing', lastRefreshAt: NOW },
      'refreshing',
    ],
    ['once stuck it stays stuck', { current: 'stuck', source: 'boundary' }, 'stuck'],
    [
      'a boundary after the Refresh offer refreshes',
      { current: 'ready', source: 'boundary', pathname: '/admin/menu' },
      'refreshing',
    ],
  ])('%s', (_, change, expected) => {
    expect(decide({ ...BOARD, ...change })).toBe(expected);
  });
});

describe('what becomes of an older build’s answer', () => {
  it.each<[string, Parameters<typeof handlingFor>, Handling]>([
    ['held while a live screen refreshes', ['refreshing', '/staff', true], 'hold'],
    ['held while any other page refreshes too', ['refreshing', '/admin/menu', true], 'hold'],
    ['passed on a live screen that is stuck', ['stuck', '/t/AbC123/cart', true], 'pass'],
    ['kept back where Refresh is offered', ['ready', '/admin/menu', true], 'keep'],
    ['kept back there when stuck too', ['stuck', '/super/restaurants', true], 'keep'],
    ['kept back on the website', ['ready', '/hi/signup', true], 'keep'],
    ['kept back on login', ['stuck', '/login', true], 'keep'],
    ['passed offline, where no toast is shown', ['ready', '/admin/menu', false], 'pass'],
  ])('%s', (_, args, expected) => {
    expect(handlingFor(...args)).toBe(expected);
  });

  it('keeps it back on every page that doesn’t refresh by itself, and only there', () => {
    for (const path of ['/staff', '/staff/kitchen', '/admin/live', '/t/AbC123', '/t/AbC123/cart']) {
      expect(handlingFor('stuck', path, true), path).toBe('pass');
    }
    for (const path of ['/admin', '/admin/menu/import/7f0a', '/super', '/', '/hi', '/login']) {
      for (const notice of ['ready', 'stuck'] as const) {
        expect(handlingFor(notice, path, true), `${notice} ${path}`).toBe('keep');
      }
    }
  });
});

/** sessionStorage as a Map; `broken` throws, as blocked site data does. */
function fakeStore({ broken = false } = {}) {
  const map = new Map<string, string>();
  return {
    getItem(key: string) {
      if (broken) throw new DOMException('Blocked', 'SecurityError');
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (broken) throw new DOMException('Blocked', 'SecurityError');
      map.set(key, value);
    },
  };
}

describe('the loop guard', () => {
  it('remembers the tab’s refresh', () => {
    const store = fakeStore();
    expect(lastRefresh(store)).toBeNull();
    expect(rememberRefresh(store, { at: 5, from: 'dpl_a', cause: 'version' })).toBe(true);
    expect(lastRefresh(store)).toEqual({ at: 5, from: 'dpl_a', cause: 'version', noticed: false });
  });

  it('remembers nothing without storage, so the page must not refresh by itself', () => {
    const store = fakeStore({ broken: true });
    expect(rememberRefresh(store, { at: 5, from: null, cause: 'version' })).toBe(false);
    expect(rememberRefresh(null, { at: 5, from: null, cause: 'version' })).toBe(false);
    expect(lastRefresh(store)).toBeNull();
  });

  it('counts a damaged record as none', () => {
    const store = fakeStore();
    for (const raw of [
      '{',
      '42',
      '{"at":"5"}',
      '{"at":5,"from":null,"cause":"x","noticed":false}',
    ]) {
      store.setItem(REFRESH_KEY, raw);
      expect(lastRefresh(store), raw).toBeNull();
    }
  });

  it('lets the refreshed page say so once, within 30 s', () => {
    const store = fakeStore();
    rememberRefresh(store, { at: 1000, from: 'dpl_a', cause: 'version' });
    expect(takeRefreshNotice(store, 2000, 'dpl_b')).toBe('updated');
    expect(takeRefreshNotice(store, 2000, 'dpl_b')).toBeNull();

    rememberRefresh(store, { at: 1000, from: null, cause: 'version' });
    expect(takeRefreshNotice(store, 1000 + NOTICE_MS, null)).toBeNull();
    // Locally and in CI there is no deployment id: a refresh counts as updated.
    rememberRefresh(store, { at: 1000, from: null, cause: 'version' });
    expect(takeRefreshNotice(store, 2000, null)).toBe('updated');
  });

  it('is stuck when the same build came back; a missing script needs no word', () => {
    const store = fakeStore();
    rememberRefresh(store, { at: 1000, from: 'dpl_a', cause: 'version' });
    expect(takeRefreshNotice(store, 2000, 'dpl_a')).toBe('stuck');
    rememberRefresh(store, { at: 1000, from: 'dpl_a', cause: 'chunk' });
    expect(takeRefreshNotice(store, 2000, 'dpl_a')).toBeNull();
    expect(lastRefresh(store)?.noticed).toBe(true);
  });
});

describe('the fetch observer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes other answers through untouched', async () => {
    const response = new Response('{}');
    const onStale = vi.fn((): Handling => 'keep');
    const watched = watchFetch(async () => response, onStale);
    expect(await watched('/t/AbC123/session')).toBe(response);
    expect(onStale).not.toHaveBeenCalled();
  });

  it('holds an older build’s answer while the page refreshes, then lets it through', async () => {
    const response = staleResponse();
    const watched = watchFetch(
      async () => response,
      () => 'hold',
    );
    let settled: Response | undefined;
    void watched('/staff', { method: 'POST' }).then((value) => (settled = value));
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(response);
  });

  it('lets it through at once when told to', async () => {
    const response = staleResponse();
    const watched = watchFetch(
      async () => response,
      () => 'pass',
    );
    expect(await watched('/staff', { method: 'POST' })).toBe(response);
  });

  // The action then neither fails nor ends, so no caller can rethrow it into the error page.
  it('keeps it back for good when the page offers Refresh', async () => {
    const watched = watchFetch(
      async () => staleResponse(),
      () => 'keep',
    );
    let settled = false;
    void watched('/admin/menu', { method: 'POST' }).then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(HOLD_MS * 10);
    expect(settled).toBe(false);
  });

  it('never catches: a failed request stays a TypeError', async () => {
    const error = new TypeError('Failed to fetch');
    const watched = watchFetch(
      async () => {
        throw error;
      },
      () => 'hold',
    );
    await expect(watched('/staff')).rejects.toBe(error);
  });
});

describe('the tab’s notice', () => {
  // The tab's fetch, wrapped once as in a browser; each test says what the server answers.
  let answer: () => Promise<Response>;
  beforeAll(() => {
    window.fetch = () => answer();
  });

  // What the page puts on the document and the window. jsdom keeps both between tests, so the
  // listeners of a page that kept an answer come off again when its test is done.
  const spyOnListeners = () => ({
    document: vi.spyOn(document, 'addEventListener'),
    window: vi.spyOn(window, 'addEventListener'),
  });
  let added: ReturnType<typeof spyOnListeners>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    sessionStorage.clear();
    document.documentElement.lang = 'en';
    delete document.documentElement.dataset.newVersion;
    answer = async () => staleResponse();
    toast.mockClear();
    toast.dismiss.mockClear();
    toast.success.mockClear();
    added = spyOnListeners();
  });
  afterEach(() => {
    for (const [type, listener, options] of added.document.mock.calls) {
      document.removeEventListener(type, listener, options);
    }
    for (const [type, listener, options] of added.window.mock.calls) {
      window.removeEventListener(type, listener, options);
    }
    document.body.innerHTML = '';
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** A fresh tab on this page, watching its actions. */
  async function openPage(path: string) {
    history.replaceState(null, '', path);
    const notice = await import('@/features/new-version/notice');
    notice.watchForNewVersion();
    return notice;
  }

  /** Whether a call to the server has answered, or failed, `ms` later. */
  async function settledAfter(call: Promise<unknown>, ms: number) {
    let settled = false;
    void call.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(ms);
    return settled;
  }

  it('claims nothing for a script that fails in the background', async () => {
    await openPage('/t/AbC123');
    const error = chunkError();
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: error }));
    // A listener of our own, or the test runner reports the event's error as uncaught.
    const listener = vi.fn();
    window.addEventListener('error', listener);
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
    window.removeEventListener('error', listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  // A held answer would never settle here: these timers only run when advanced.
  it('offline, neither refreshes nor claims anything', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await openPage('/staff');
    expect((await window.fetch('/staff', { method: 'POST' })).status).toBe(409);
    expect(toast).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it('offers Refresh in the admin panel and leaves the page as it is, its action pending', async () => {
    await openPage('/admin/menu');
    const call = window.fetch('/admin/menu', { method: 'POST' });
    // Never answered nor failed, so no caller can throw it at the error page (VPS-8).
    expect(await settledAfter(call, HOLD_MS * 3)).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      'A new version is ready',
      expect.objectContaining({
        description:
          'Refresh the page to keep working. If you just changed something, it wasn’t saved, and nothing will be until you refresh. Copy anything you’ve typed first.',
        duration: Infinity,
        // A closed toast could not come back: later taps wait behind the action.
        closeButton: false,
        dismissible: false,
        action: expect.objectContaining({ label: 'Refresh' }),
      }),
    );
    expect(sessionStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it.each(['/admin', '/hi/signup', '/login'])(
    'keeps the action pending within two minutes of a refresh too, at %s',
    async (path) => {
      const record = JSON.stringify({
        at: Date.now() - 60_000,
        from: null,
        cause: 'version',
        noticed: true,
      });
      sessionStorage.setItem(REFRESH_KEY, record);
      await openPage(path);
      expect(await settledAfter(window.fetch(path, { method: 'POST' }), HOLD_MS * 3)).toBe(false);
      expect(toast).toHaveBeenCalledWith(
        'The new version didn’t load',
        expect.objectContaining({
          description: expect.stringContaining(NEW_VERSION_STRINGS.en.notSaved),
          closeButton: false,
          dismissible: false,
        }),
      );
      // No second refresh.
      expect(sessionStorage.getItem(REFRESH_KEY)).toBe(record);
    },
  );

  // A switch or a reorder shows its change as made while the answer is kept back, so the toast
  // says it was not (VPS-8). Each test is a fresh page; the language is the page's.
  describe.each(['en', 'hi'] as const)('where an answer is kept back, in %s', (lang) => {
    const { ready, stuck, notSaved } = NEW_VERSION_STRINGS[lang];
    beforeEach(() => {
      document.documentElement.lang = lang;
    });

    it('the Refresh offer says that anything just changed was not saved', async () => {
      await openPage('/admin/menu');
      void window.fetch('/admin/menu', { method: 'POST' });
      await vi.advanceTimersByTimeAsync(0);
      expect(toast).toHaveBeenCalledExactlyOnceWith(
        ready.title,
        expect.objectContaining({
          description: `${ready.description} ${notSaved} ${ready.copyFirst}`,
        }),
      );
    });

    it('so does the note that the new version didn’t load', async () => {
      const refreshed = { at: Date.now() - 60_000, from: null, cause: 'version', noticed: true };
      sessionStorage.setItem(REFRESH_KEY, JSON.stringify(refreshed));
      await openPage('/super');
      void window.fetch('/super', { method: 'POST' });
      await vi.advanceTimersByTimeAsync(0);
      expect(toast).toHaveBeenCalledExactlyOnceWith(
        stuck.title,
        expect.objectContaining({ description: `${stuck.description} ${notSaved}` }),
      );
    });
  });

  // The live screens' answers pass, so what was tapped goes on working there: nothing to add.
  it.each(['/staff', '/admin/live', '/t/AbC123', '/t/AbC123/cart'])(
    'does not say it on a live screen that is stuck, at %s',
    async (path) => {
      const refreshed = { at: Date.now() - 60_000, from: null, cause: 'version', noticed: true };
      sessionStorage.setItem(REFRESH_KEY, JSON.stringify(refreshed));
      await openPage(path);
      expect((await window.fetch(path, { method: 'POST' })).status).toBe(409);
      expect(toast).toHaveBeenCalledOnce();
      const [, options] = toast.mock.calls[0]!;
      expect(options.description).not.toContain(NEW_VERSION_STRINGS.en.notSaved);
      expect(options).toMatchObject({ closeButton: true, dismissible: true });
    },
  );

  it.each(['/admin/menu', '/super', '/login', '/staff', '/t/AbC123/cart'])(
    'passes every other answer through, at %s',
    async (path) => {
      answer = async () => new Response('{}', { status: 200 });
      await openPage(path);
      expect((await window.fetch(path, { method: 'POST' })).status).toBe(200);
      expect(toast).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(REFRESH_KEY)).toBeNull();
    },
  );

  // No toast is shown offline, so nothing would tell the owner why the action hangs.
  it('offline, the admin panel gets the answer, and nothing is claimed', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await openPage('/admin/menu');
    expect((await window.fetch('/admin/menu', { method: 'POST' })).status).toBe(409);
    expect(toast).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it('refreshes the board, holding the answer meanwhile', async () => {
    await openPage('/staff');
    let settled = false;
    void window.fetch('/staff', { method: 'POST' }).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(toast.dismiss).toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(REFRESH_KEY)!)).toMatchObject({
      at: Date.now(),
      from: null,
      cause: 'version',
      noticed: false,
    });
  });

  it('is stuck within two minutes of a refresh, in the page’s language', async () => {
    const record = JSON.stringify({
      at: Date.now() - 60_000,
      from: null,
      cause: 'version',
      noticed: true,
    });
    sessionStorage.setItem(REFRESH_KEY, record);
    document.documentElement.lang = 'hi';
    await openPage('/t/AbC123/cart');
    expect((await window.fetch('/t/AbC123/cart', { method: 'POST' })).status).toBe(409);
    const { stuck, cartSaved } = NEW_VERSION_STRINGS.hi;
    expect(toast).toHaveBeenCalledWith(
      stuck.title,
      expect.objectContaining({
        description: `${stuck.description} ${cartSaved}`,
        // The answer passed, so the page goes on working and the toast can be closed.
        closeButton: true,
        dismissible: true,
      }),
    );
    // No second refresh.
    expect(sessionStorage.getItem(REFRESH_KEY)).toBe(record);
  });

  it('says once on the refreshed page that it was updated', async () => {
    sessionStorage.setItem(
      REFRESH_KEY,
      JSON.stringify({ at: Date.now() - 1000, from: null, cause: 'version', noticed: false }),
    );
    const notice = await openPage('/t/AbC123/cart');
    notice.showRefreshedNotice();
    notice.showRefreshedNotice();
    expect(toast.success).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith(
      'Updated to the new version',
      expect.objectContaining({
        description:
          'If what you just did didn’t go through, please do it again. Your cart is saved.',
      }),
    );
  });

  it('reloads for the Refresh button through the call a test can replace', async () => {
    const { pageExit, refreshNow } = await openPage('/admin/menu');
    const reload = vi.spyOn(pageExit, 'reload').mockImplementation(() => {});
    refreshNow();
    expect(reload).toHaveBeenCalledOnce();
  });

  // Next.js's own navigations wait behind a caller in a transition whose action never ends, so a
  // page with a kept answer loads links and history moves in full instead (VPS-8).
  describe('behind a kept answer, links and history moves load the page in full', () => {
    /** How many listeners of this type the page has added. Ask before the test clicks. */
    const listening = (type: string) =>
      [...added.document.mock.calls, ...added.window.mock.calls].filter(([t]) => t === type).length;

    /** A page that is told the next call leaves it: jsdom has no navigation. */
    async function openNotLeaving(path: string) {
      const notice = await openPage(path);
      return {
        load: vi.spyOn(notice.pageExit, 'load').mockImplementation(() => {}),
        reload: vi.spyOn(notice.pageExit, 'reload').mockImplementation(() => {}),
      };
    }

    /** A page whose first server action met a newer build, so its answer is kept back. */
    async function openKept(path = '/admin/menu') {
      const exits = await openNotLeaving(path);
      void window.fetch(path, { method: 'POST' });
      await vi.advanceTimersByTimeAsync(0);
      return exits;
    }

    /** A link; the label is what a finger lands on, and the link is its nearest ancestor. */
    function labelOf(attributes: string) {
      document.body.innerHTML = `<a ${attributes}><span>Tables &amp; QR</span></a>`;
      return document.querySelector('span')!;
    }

    /**
     * Clicks as a user does. Says whether the page had taken the click over by the time Next.js's
     * Link, which handles it later while it bubbles, sees it. Nothing is left for jsdom to follow.
     */
    function click(target: Element, init: MouseEventInit = {}) {
      let taken = false;
      const last = (event: Event) => {
        taken = event.defaultPrevented;
        event.preventDefault();
      };
      document.addEventListener('click', last);
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
      document.removeEventListener('click', last);
      return taken;
    }

    /** The mark the stylesheet reads (globals.css): taps stop on the controls that show a change. */
    const marker = () => document.documentElement.dataset.newVersion;

    it('puts nothing on the page before an answer is kept, and leaves links and history alone', async () => {
      const { load, reload } = await openNotLeaving('/admin/menu');
      expect(listening('click')).toBe(0);
      expect(listening('popstate')).toBe(0);
      expect(marker()).toBeUndefined();
      expect(click(labelOf('href="/admin/tables"'))).toBe(false);
      history.replaceState(null, '', '/admin/tables');
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(load).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });

    it.each<[string, string, () => void]>([
      ['held while a live screen refreshes', '/staff', () => {}],
      [
        'passed on a live screen that is stuck',
        '/t/AbC123/cart',
        () => {
          const refreshed = {
            at: Date.now() - 60_000,
            from: null,
            cause: 'version',
            noticed: true,
          };
          sessionStorage.setItem(REFRESH_KEY, JSON.stringify(refreshed));
        },
      ],
      [
        'passed offline',
        '/admin/menu',
        () => void vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false),
      ],
      [
        'not an older build’s at all',
        '/admin/menu',
        () => {
          answer = async () => new Response('{}', { status: 200 });
        },
      ],
    ])('puts nothing on a page whose answer is %s', async (_, path, setUp) => {
      setUp();
      await openNotLeaving(path);
      void window.fetch(path, { method: 'POST' });
      await vi.advanceTimersByTimeAsync(0);
      expect(listening('click')).toBe(0);
      expect(listening('popstate')).toBe(0);
      expect(marker()).toBeUndefined();
    });

    it('is put there once, by the first answer that is kept', async () => {
      await openNotLeaving('/admin/menu');
      const written: MutationRecord[] = [];
      const writes = new MutationObserver((records) => written.push(...records));
      writes.observe(document.documentElement, { attributeFilter: ['data-new-version'] });
      for (let kept = 0; kept < 2; kept++) {
        void window.fetch('/admin/menu', { method: 'POST' });
        await vi.advanceTimersByTimeAsync(0);
        expect(listening('click')).toBe(1);
        expect(listening('popstate')).toBe(1);
        expect(marker()).toBe('kept');
      }
      // Written once, not again by the second answer.
      written.push(...writes.takeRecords());
      expect(written).toHaveLength(1);
      writes.disconnect();
      // Before Next.js's Link, which listens while the click bubbles.
      expect(added.document).toHaveBeenCalledWith('click', expect.any(Function), true);
    });

    it('marks <html> with what the stylesheet looks for', () => {
      const stylesheet = readFileSync('src/app/globals.css', 'utf8');
      expect(stylesheet).toContain("html[data-new-version='kept']");
    });

    it.each([
      ['a link to another page', 'href="/admin/tables"', '/admin/tables'],
      ['a relative link', 'href="tables"', '/admin/tables'],
      [
        'a link to this page with another query',
        'href="/admin/menu?view=hidden"',
        '/admin/menu?view=hidden',
      ],
      ['a link to a place on another page', 'href="/admin/tables#new"', '/admin/tables#new'],
      ['a link that names this tab', 'href="/admin/tables" target="_self"', '/admin/tables'],
      // The browser scrolls there and adds a history entry, with no reload; Next.js's own move
      // would wait behind the action and nothing would happen.
      ['a link to a place on this page', 'href="#prices"', '/admin/menu#prices'],
      ['a link to this page and a place on it', 'href="/admin/menu#prices"', '/admin/menu#prices'],
      [
        'a link to another page of the website’s menu, which scrolls to its own sections itself',
        'href="/admin/tables" data-scrolls-itself',
        '/admin/tables',
      ],
    ])('loads %s in full', async (_, attributes, address) => {
      const { load } = await openKept('/admin/menu');
      expect(click(labelOf(attributes))).toBe(true);
      expect(load).toHaveBeenCalledExactlyOnceWith(location.origin + address);
    });

    it.each<[string, string, MouseEventInit]>([
      ['a click with the meta key', 'href="/admin/tables"', { metaKey: true }],
      ['a click with the ctrl key', 'href="/admin/tables"', { ctrlKey: true }],
      ['a click with the shift key', 'href="/admin/tables"', { shiftKey: true }],
      ['a click with the alt key', 'href="/admin/tables"', { altKey: true }],
      ['a click of the middle button', 'href="/admin/tables"', { button: 1 }],
      ['a link that opens a new tab', 'href="/admin/tables" target="_blank"', {}],
      ['a link that downloads', 'href="/admin/tables.csv" download', {}],
      ['a link that downloads under a name', 'href="/tables.csv" download="tables.csv"', {}],
      ['a link to another site', 'href="https://example.com/admin/tables"', {}],
      ['a link that is no page', 'href="mailto:help@example.com"', {}],
      ['a link to this page', 'href="/admin/menu"', {}],
      ['a link to this page without a place', 'href="#"', {}],
      ['a link that scrolls to its place itself', 'href="#prices" data-scrolls-itself', {}],
      [
        'a link to this page and a place on it that scrolls itself',
        'href="/admin/menu#prices" data-scrolls-itself',
        {},
      ],
    ])('leaves %s alone', async (_, attributes, init) => {
      const { load } = await openKept('/admin/menu');
      expect(click(labelOf(attributes), init)).toBe(false);
      expect(load).not.toHaveBeenCalled();
    });

    it('follows a link to the place the page is at, which scrolls back to it', async () => {
      const { load } = await openKept('/admin/menu#prices');
      expect(click(labelOf('href="#prices"'))).toBe(true);
      expect(load).toHaveBeenCalledExactlyOnceWith(location.origin + '/admin/menu#prices');
    });

    // The website's menu sheet takes a click on a section of its page over (goTo), and scrolls
    // once the sheet has closed, adding its own history entry: one more from here would double it.
    it('leaves the website’s menu sheet the sections it scrolls to itself', () => {
      const sheet = readFileSync('src/features/site/components/site-mobile-nav.tsx', 'utf8');
      // The attribute is on the link that goTo handles.
      const link = sheet.slice(sheet.indexOf('onClick={(event) => goTo(event, href)}'));
      expect(link.slice(0, link.indexOf('className='))).toContain('data-scrolls-itself');
    });

    it('leaves a click that something else has taken over alone', async () => {
      // Added first, so it runs first.
      document.addEventListener('click', (event) => event.preventDefault(), true);
      const { load } = await openKept();
      click(labelOf('href="/admin/tables"'));
      expect(load).not.toHaveBeenCalled();
    });

    it('leaves a click on anything but a link alone', async () => {
      const { load } = await openKept();
      document.body.innerHTML =
        '<button><span>Save</span></button><a name="top"><span>Top</span></a>';
      for (const target of document.querySelectorAll('button, span, a')) {
        expect(click(target)).toBe(false);
      }
      expect(load).not.toHaveBeenCalled();
    });

    it('reloads on back or forward, the address the browser has moved to', async () => {
      const { reload } = await openKept('/admin/menu/import/7f0a');
      // The URL is the new entry's by the time popstate fires.
      history.replaceState(null, '', '/admin/menu/import');
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(reload).toHaveBeenCalledOnce();
    });

    it('leaves a move to another place on the same page alone', async () => {
      const { reload } = await openKept('/admin/menu/import/7f0a');
      for (const address of ['/admin/menu/import/7f0a#prices', '/admin/menu/import/7f0a']) {
        history.replaceState(null, '', address);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
      expect(reload).not.toHaveBeenCalled();
    });
  });
});

describe('the words', () => {
  const { en, hi } = NEW_VERSION_STRINGS;
  const DEVANAGARI = /[ऀ-ॿ]/;

  /** Every string leaf of a dictionary, by its dotted path (as staff-strings.test.ts). */
  function leaves(value: unknown, path = ''): [string, string][] {
    if (typeof value === 'string') return [[path, value]];
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, child]) =>
        leaves(child, path ? `${path}.${key}` : key),
      );
    }
    return [];
  }

  it('Hindi has every English key', () => {
    const keys = (value: unknown): string[] =>
      value && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)])
        : [];
    expect(keys(hi)).toEqual(keys(en));
  });

  it('every Hindi word is in Devanagari, with nuktas as separate marks', () => {
    for (const [path, text] of [...leaves(hi), ['error.code', hi.error.code('4f2a')]]) {
      expect(text, path).toMatch(DEVANAGARI);
      expect(text, path).not.toMatch(/[क़-य़]/);
    }
    const source = readFileSync('src/features/new-version/strings.ts', 'utf8');
    expect(source).not.toMatch(/[क़-य़]/);
    expect(source).not.toContain('हिंदी');
  });

  it('never name the product: guests only know the restaurant', () => {
    const all = [...leaves(en), ...leaves(hi)].map(([, text]) => text).join('\n');
    expect(all.toLowerCase()).not.toContain(APP_NAME.toLowerCase());
  });
});
