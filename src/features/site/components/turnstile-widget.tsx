'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

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
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const report = useEffectEvent((ready: boolean) => onReady(ready));

  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;
    const fail = () => {
      report(false);
      if (!cancelled) setFailed(true);
    };
    report(false);
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        widgetId = turnstile.render(container.current, {
          sitekey: siteKey,
          action: 'lead',
          theme: 'light',
          // "flexible" needs 300 px; narrow phones get the compact widget.
          size: container.current.clientWidth < 300 ? 'compact' : 'flexible',
          callback: () => report(true),
          'expired-callback': () => report(false),
          'error-callback': fail,
        });
      })
      .catch(fail);
    return () => {
      cancelled = true;
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [siteKey, round, attempt]);

  return (
    <div className="flex flex-col gap-2">
      <div ref={container} className="min-h-[65px] min-w-0" />
      {failed && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-status-void">
          <p>The check that you’re not a robot didn’t load. Try again, or reach us directly.</p>
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={() => {
              setFailed(false);
              setAttempt((count) => count + 1);
            }}
          >
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
