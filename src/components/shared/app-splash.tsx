'use client';

import { useEffect, useRef } from 'react';

import { COMPANY_NAME } from '@/lib/config';

import { LogoMark } from './logo';

/** Past this on the screen's own clock, the CSS fallback (5 s) is about to fade it alone. */
const FALLBACK_MS = 4500;

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
    const shown = Number(fallback.currentTime ?? 0);
    // Too late to animate: the fallback is about to fade it on its own.
    if (shown > FALLBACK_MS) return launched();

    const onEnd = (event: AnimationEvent) => {
      if (event.target === splash && EXITS.has(event.animationName)) launched();
    };
    const done = () => {
      splash.dataset.done = '';
    };
    splash.addEventListener('animationend', onEnd);
    const timer = window.setTimeout(done, FALLBACK_MS - shown);
    if (document.readyState === 'complete') done();
    else window.addEventListener('load', done, { once: true });
    return () => {
      splash.removeEventListener('animationend', onEnd);
      window.removeEventListener('load', done);
      window.clearTimeout(timer);
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
