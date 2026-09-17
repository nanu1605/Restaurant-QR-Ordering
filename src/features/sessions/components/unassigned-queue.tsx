'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { tableHeading } from '@/features/ordering/format';
import type { BoardTable } from '@/features/orders/board';
import { formatElapsed, minutesSince, tableState } from '@/features/orders/board-view';
import { TableStateBadge } from '@/features/orders/components/table-state-badge';
import { useBoard } from '@/features/orders/use-board';
import { useServerNow } from '@/features/orders/use-server-now';

import { AssignWaiterDialog } from './assign-waiter-dialog';

/** Unassigned tables, oldest first, pinned above the live board (spec §10.7, §13.3). */
export function UnassignedQueue() {
  const { data: board } = useBoard();
  const nowMs = useServerNow(board);
  const [target, setTarget] = useState<BoardTable | null>(null);

  if (!board) return null;
  const tables = board.tables
    .filter((table) => table.session && !table.session.assignedWaiterId)
    .sort((a, b) => a.session!.openedAt.localeCompare(b.session!.openedAt));
  if (tables.length === 0 && !target) return null;

  return (
    <section
      aria-labelledby="unassigned-heading"
      className="flex flex-col gap-2 rounded-lg border-2 border-attention bg-surface p-3"
    >
      <h2
        id="unassigned-heading"
        className="flex items-center gap-2 text-base font-semibold text-ink"
      >
        Unassigned tables
        <span className="rounded-full bg-attention px-2 text-sm text-attention-foreground tabular-nums">
          {tables.length}
        </span>
      </h2>
      <ul className="flex flex-col divide-y divide-line">
        {tables.map((table) => {
          const heading = tableHeading(table.label);
          return (
            <li key={table.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex flex-wrap items-center gap-3">
                <span className="text-lg font-bold text-ink">{heading}</span>
                <TableStateBadge state={tableState(table)} />
                <span className="text-sm text-ink-muted tabular-nums">
                  Seated {formatElapsed(minutesSince(table.session!.openedAt, nowMs))} ago
                </span>
              </span>
              <Button size="touch" onClick={() => setTarget(table)}>
                Assign waiter<span className="sr-only"> to {heading}</span>
              </Button>
            </li>
          );
        })}
      </ul>

      <AssignWaiterDialog
        board={board}
        sessionId={target?.session?.id ?? null}
        tableLabel={target?.label ?? ''}
        currentWaiterId={null}
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
      />
    </section>
  );
}
