'use client';

import { hashKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';

import { useLive } from '@/features/live/live-provider';
import { BOARD_MUTATION_KEY, boardKey } from '@/features/live/query-client';
import { playChime } from '@/features/live/sound';
import { tableHeading } from '@/features/ordering/format';

import type { Board } from '../board';
import { type BoardSnapshot, diffBoard, snapshotOf } from '../alerts';
import { highlightTables, ownOrderIds } from '../alert-store';
import { useBoard } from '../use-board';

/** Cached board data older than this is not trusted as the baseline. */
const FRESH_MS = 15_000;

type BoardAlertsProps = {
  /** Admin screens also chime when a table is newly seated (spec §13.3 Unassigned queue). */
  newSessions?: boolean;
};

/**
 * Toast, highlight and chime for new orders and customer requests (spec §12). Keeps the board query
 * alive on every page it is mounted on, and compares each board refresh with
 * the last one (docs/DECISIONS.md P4-16). The first load stays quiet, and so
 * does a board the cache kept while this screen was away: orders that came in
 * meanwhile were someone else's to hear.
 */
export function BoardAlerts({ newSessions = false }: BoardAlertsProps) {
  const queryClient = useQueryClient();
  const { memberId } = useLive();
  // Pages without a board of their own (Availability) still refetch it.
  useBoard({ watchOnly: true });

  useEffect(() => {
    const key = boardKey(memberId);
    const hash = hashKey(key);
    const state = queryClient.getQueryState<Board>(key);
    const fresh =
      state?.data !== undefined &&
      !state.isInvalidated &&
      Date.now() - state.dataUpdatedAt < FRESH_MS;
    let previous: BoardSnapshot | null = fresh && state.data ? snapshotOf(state.data) : null;

    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.query.queryHash !== hash) return;
      const board = event.query.state.data as Board | undefined;
      if (!board) return;

      // Newer server data hydrated on navigation: the new baseline, no alerts.
      if (event.action.type === 'setState') {
        previous = snapshotOf(board);
        return;
      }
      if (event.action.type !== 'success') return;
      // Optimistic updates while this device changes the board: compare again
      // once its last change has refetched.
      if (queryClient.isMutating({ mutationKey: BOARD_MUTATION_KEY }) > 0) return;

      const alerts = diffBoard(previous, board, ownOrderIds());
      previous = snapshotOf(board);
      const sessions = newSessions ? alerts.sessions : [];
      if (alerts.orders.length === 0 && sessions.length === 0 && alerts.requests.length === 0) {
        return;
      }

      for (const order of alerts.orders) {
        const table = tableHeading(order.tableLabel);
        toast(order.waiting ? `${table} needs approval` : `New order · ${table}`, {
          description: order.roundNumber > 1 ? `Round ${order.roundNumber}` : undefined,
        });
      }
      const sessionsWithoutOrderToast = sessions.filter(
        (session) => !alerts.orders.some((order) => order.tableId === session.tableId),
      );
      for (const session of sessionsWithoutOrderToast) {
        toast(`${tableHeading(session.tableLabel)} is seated`, { description: 'Assign a waiter' });
      }
      for (const request of alerts.requests) {
        const table = tableHeading(request.tableLabel);
        toast(
          request.type === 'call_waiter'
            ? `${table} is calling a waiter`
            : `${table} asked for the bill`,
        );
      }
      highlightTables([
        ...alerts.orders.map((order) => order.tableId),
        ...sessions.map((session) => session.tableId),
        ...alerts.requests.map((request) => request.tableId),
      ]);
      playChime();
    });
  }, [queryClient, memberId, newSessions]);

  return null;
}
