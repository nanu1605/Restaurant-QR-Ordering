'use client';

import { useNow } from '@/hooks/use-now';

/** Elapsed times only need minute precision. */
const TICK_MS = 30_000;

/**
 * "Now" by the server's clock (tablets drift): the device clock plus the
 * offset seen when the board was fetched. Before mounting it is the fetch
 * time itself, so server and browser render the same text.
 */
export function useServerNow(serverNow: string | undefined, fetchedAt: number): number {
  const tick = useNow(TICK_MS);
  const offset = serverNow ? Date.parse(serverNow) - fetchedAt : 0;
  return (tick ?? fetchedAt) + offset;
}
