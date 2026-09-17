'use client';

import { hashKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';

import { useLive } from '@/features/live/live-provider';
import { boardKey } from '@/features/live/query-client';
import { playChime } from '@/features/live/sound';
import { tableHeading } from '@/features/ordering/format';

import type { Board } from '../board';
import { type BoardSnapshot, diffBoard, snapshotOf } from '../alerts';
import { highlightTables, ownOrderIds } from '../alert-store';

type BoardAlertsProps = {
  /** Admin screens also chime when a table is newly seated (spec §13.3 Unassigned queue). */
  newSessions?: boolean;
};

/**
 * Toast, highlight and chime for new orders (spec §12). Watches the board
 * query's refreshes and compares each with the last one (docs/DECISIONS.md
 * P4-16); the first load stays quiet.
 */
export function BoardAlerts({ newSessions = false }: BoardAlertsProps) {
  const queryClient = useQueryClient();
  const { memberId } = useLive();

  useEffect(() => {
    const key = boardKey(memberId);
    const current = queryClient.getQueryData<Board>(key);
    let previous: BoardSnapshot | null = current ? snapshotOf(current) : null;

    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      if (event.query.queryHash !== hashKey(key)) return;
      const board = event.query.state.data as Board | undefined;
      if (!board) return;

      const alerts = diffBoard(previous, board, ownOrderIds());
      previous = snapshotOf(board);
      const sessions = newSessions ? alerts.sessions : [];
      if (alerts.orders.length === 0 && sessions.length === 0) return;

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
      highlightTables([
        ...alerts.orders.map((order) => order.tableId),
        ...sessions.map((session) => session.tableId),
      ]);
      playChime();
    });
  }, [queryClient, memberId, newSessions]);

  return null;
}
