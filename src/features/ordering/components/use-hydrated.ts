'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * False while server rendering and hydrating, true once the browser has taken
 * over, so views that depend on localStorage don't claim "empty" before it's read.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
