'use client';

import { useSyncExternalStore } from 'react';

/**
 * Shared clocks, one interval per tick length however many components listen:
 * countdowns tick every second, elapsed times on the live board every 30 s.
 */
type Clock = {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | undefined;
  subscribe: (onChange: () => void) => () => void;
  snapshot: () => number | null;
};

const clocks = new Map<number, Clock>();

function clockFor(intervalMs: number): Clock {
  const existing = clocks.get(intervalMs);
  if (existing) return existing;

  const clock: Clock = {
    now: 0,
    listeners: new Set(),
    timer: undefined,
    subscribe: (onChange) => {
      if (clock.listeners.size === 0) {
        clock.now = Date.now();
        clock.timer = setInterval(() => {
          clock.now = Date.now();
          for (const listener of clock.listeners) listener();
        }, intervalMs);
      }
      clock.listeners.add(onChange);
      return () => {
        clock.listeners.delete(onChange);
        if (clock.listeners.size === 0) clearInterval(clock.timer);
      };
    },
    snapshot: () => (clock.listeners.size === 0 ? null : clock.now),
  };
  clocks.set(intervalMs, clock);
  return clock;
}

/**
 * The device's clock, ticking every `intervalMs`. Null while server rendering
 * and until mounted, so the markup never mismatches on hydration.
 */
export function useNow(intervalMs = 1000): number | null {
  const clock = clockFor(intervalMs);
  return useSyncExternalStore(clock.subscribe, clock.snapshot, () => null);
}
