'use client';

import { useNow } from '@/hooks/use-now';

import type { Board } from './board';

/** Elapsed times only need minute precision. */
const TICK_MS = 30_000;

/**
 * "Now" by the server's clock (tablets drift): the device clock plus the
 * offset seen when the board was fetched. The fetch time travels with the
 * board, so optimistic updates don't disturb it. Before mounting it is the
 * fetch time itself, so server and browser render the same text.
 */
export function useServerNow(board: Pick<Board, 'now' | 'fetchedAt'> | undefined): number {
  const tick = useNow(TICK_MS);
  if (!board) return tick ?? 0;
  return (tick ?? board.fetchedAt) + Date.parse(board.now) - board.fetchedAt;
}
