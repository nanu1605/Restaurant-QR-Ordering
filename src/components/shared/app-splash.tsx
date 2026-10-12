'use client';

import { useEffect, useRef } from 'react';

import { COMPANY_NAME } from '@/lib/config';

import { LogoMark } from './logo';

/** Past this on the screen's own clock, the CSS fallback (5 s) is about to fade it alone. */
const FALLBACK_MS = 4500;
/**
 * How long the screen stays, at least, before the zoom: from when it appears, and after the page
 * has loaded. Pages often load within 0.2 s of the first paint, and Android shows its own splash
 * over the first moments, so without these the screen would come and go unseen (P11-4).
 */
const SHOWN_MS = 1500;
const AFTER_LOAD_MS = 700;

const EXITS = new Set(['app-splash-out', 'app-splash-fade']);

/**
 * The installed app's launch screen (spec §16.1; docs/DECISIONS.md P11-4, P11-5): the logo and
 * "Powered by …" while the page loads, then the logo zooms in and the screen fades away. CSS
 * shows it only in the installed app (display-mode: standalone) and until <html data-launched>
 * is set, so browser tabs and in-app navigation never see it. It takes no focus.
 */
export function AppSplash() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const splash = ref.current;
    // The fallback fade's clock starts when the screen is first painted; a browser tab, where
    // the screen is hidden, has none and nothing to do.
    const fallback = splash
      ?.getAnimations()
      .find((a) => a instanceof CSSAnimation && a.animationName === 'app-splash-out');
    if (!splash || !fallback) return;
    const root = document.documentElement;
    const launched = () => {
      root.dataset.launched = '';
    };
    const shown = () => Number(fallback.currentTime ?? 0);
    // Too late to animate: the fallback is about to fade it on its own.
    if (shown() > FALLBACK_MS) return launched();

    const onEnd = (event: AnimationEvent) => {
      if (event.target === splash && EXITS.has(event.animationName)) launched();
    };
    const done = () => {
      splash.dataset.done = '';
    };
    let hold: number | undefined;
    // Loaded: zoom once the screen has been up long enough, and always before the fallback.
    const loaded = () => {
      const now = shown();
      const wait = Math.max(AFTER_LOAD_MS, SHOWN_MS - now);
      hold = window.setTimeout(done, Math.max(0, Math.min(wait, FALLBACK_MS - now)));
    };
    splash.addEventListener('animationend', onEnd);
    const timer = window.setTimeout(done, FALLBACK_MS - shown());
    if (document.readyState === 'complete') loaded();
    else window.addEventListener('load', loaded, { once: true });
    return () => {
      splash.removeEventListener('animationend', onEnd);
      window.removeEventListener('load', loaded);
      window.clearTimeout(timer);
      window.clearTimeout(hold);
    };
  }, []);

  return (
    <div ref={ref} aria-hidden className="app-splash">
      <LogoMark className="app-splash-logo size-24" />
      <p className="absolute bottom-12 px-6 text-center text-sm text-ink-muted">
        Powered by {COMPANY_NAME}
      </p>
    </div>
  );
}
