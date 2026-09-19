'use client';

import { cn } from 'cn';
import Link from 'next/link';

import { tableHeading } from '@/features/ordering/format';
import type { BoardTable } from '@/features/orders/board';
import {
  formatElapsed,
  minutesSince,
  statusCounts,
  tableState,
  type TableTone,
  tableTone,
  waiterName,
} from '@/features/orders/board-view';
import type { Board } from '@/features/orders/board';
import { TableStateBadge } from '@/features/orders/components/table-state-badge';
import { useBoard } from '@/features/orders/use-board';
import { useServerNow } from '@/features/orders/use-server-now';

/** Left edge in the colour of the least-advanced dish, as on the board (spec §10.4). */
const EDGE: Record<TableTone, string> = {
  attention: 'border-l-attention',
  placed: 'border-l-status-placed',
  preparing: 'border-l-status-preparing',
  ready: 'border-l-status-ready',
  served: 'border-l-status-served',
  free: 'border-l-line',
};

/**
 * Mini live board (spec §13.3 Dashboard): every table at a glance, linking to
 * Live orders for the detail.
 */
export function MiniBoard() {
  const { data: board } = useBoard();
  const nowMs = useServerNow(board);
  if (!board) return null;

  return (
    <section aria-labelledby="mini-board-heading" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="mini-board-heading" className="text-sm font-semibold text-ink-muted">
          Tables
        </h2>
        <Link
          href="/admin/live"
          className="text-sm font-medium text-brand underline underline-offset-4"
        >
          Open Live orders
        </Link>
      </div>
      <BoardTiles board={board} nowMs={nowMs} href="/admin/live" />
    </section>
  );
}

/**
 * Every table as a small tile: state, waiter, time seated and dishes on the
 * way. With `href`, each tile links there; without, the tiles are read-only
 * (the super-admin support view).
 */
export function BoardTiles({ board, nowMs, href }: { board: Board; nowMs: number; href?: string }) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {board.tables.map((table) => (
        <li key={table.id}>
          <MiniTile table={table} board={board} nowMs={nowMs} href={href} />
        </li>
      ))}
    </ul>
  );
}

function MiniTile({
  table,
  board,
  nowMs,
  href,
}: {
  table: BoardTable;
  board: Parameters<typeof waiterName>[0];
  nowMs: number;
  href?: string;
}) {
  const state = tableState(table);
  const session = table.session;
  const counts = statusCounts(table);
  const pending = counts.placed + counts.preparing + counts.ready;
  const waiter = session ? waiterName(board, session.assignedWaiterId) : null;

  const className = cn(
    'flex h-full flex-col gap-1.5 rounded-lg border border-l-4 border-line bg-surface p-3',
    href &&
      'hover:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
    EDGE[tableTone(table)],
  );
  const content = (
    <>
      <span className="text-base font-semibold text-ink">{tableHeading(table.label)}</span>
      <TableStateBadge state={state} className="h-7 self-start text-sm" />
      <span className="text-sm text-ink-muted">
        {session
          ? `${waiter ?? 'Unassigned'} · ${formatElapsed(minutesSince(session.openedAt, nowMs))}`
          : 'Waiting for guests'}
      </span>
      {pending > 0 && (
        <span className="text-sm text-ink">
          {pending} {pending === 1 ? 'dish' : 'dishes'} on the way
        </span>
      )}
    </>
  );

  return href ? (
    <Link href={href} data-table={table.label} data-state={state} className={className}>
      {content}
    </Link>
  ) : (
    <div data-table={table.label} data-state={state} className={className}>
      {content}
    </div>
  );
}
