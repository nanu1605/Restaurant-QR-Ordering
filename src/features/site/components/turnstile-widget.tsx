'use client';

import { useEffect, useEffectEvent, useRef } from 'react';

/**
 * Cloudflare Turnstile's widget (docs/DECISIONS.md W-6). Rendered inside a
 * form, it adds the hidden `cf-turnstile-response` input the server checks.
 * A new `round` renders a fresh widget, since each token works only once.
 */

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type Turnstile = {
  render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let script: Promise<Turnstile> | null = null;

/** Loads Cloudflare's script once, on first use (it must come from Cloudflare itself). */
function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  script ??= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = SRC;
    tag.async = true;
    tag.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('no turnstile'));
    tag.onerror = () => {
      script = null;
      tag.remove();
      reject(new Error('Turnstile did not load'));
    };
    document.head.append(tag);
  });
  return script;
}

export function TurnstileWidget({
  siteKey,
  round,
  onReady,
}: {
  siteKey: string;
  round: number;
  /** true with a token, false when it expired or failed. */
  onReady: (ready: boolean) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const report = useEffectEvent((ready: boolean) => onReady(ready));

  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;
    report(false);
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        widgetId = turnstile.render(container.current, {
          sitekey: siteKey,
          action: 'lead',
          theme: 'light',
          size: 'flexible',
          callback: () => report(true),
          'expired-callback': () => report(false),
          'error-callback': () => report(false),
        });
      })
      .catch(() => report(false));
    return () => {
      cancelled = true;
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [siteKey, round]);

  return <div ref={container} className="min-h-[65px]" />;
}
