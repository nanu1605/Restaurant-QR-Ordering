'use client';

import { useSyncExternalStore } from 'react';

let now = 0;
let subscribers = 0;

function subscribe(onChange: () => void): () => void {
  if (subscribers === 0) now = Date.now();
  subscribers += 1;
  const timer = window.setInterval(() => {
    now = Date.now();
    onChange();
  }, 1000);
  return () => {
    window.clearInterval(timer);
    subscribers -= 1;
  };
}

/**
 * The phone's clock, ticking every second, for countdowns. Null while server
 * rendering and until mounted, so the markup never mismatches on hydration.
 */
export function useNow(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => (subscribers === 0 ? null : now),
    () => null,
  );
}
