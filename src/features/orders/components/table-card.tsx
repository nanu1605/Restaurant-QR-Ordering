'use client';

import { cn } from 'cn';
import { Clock3 } from 'lucide-react';

import type { Board, BoardTable } from '../board';
import {
  type TableTone,
  minutesSince,
  statusCounts,
  tableState,
  tableTone,
  waiterName,
} from '../board-view';
import { useHighlighted } from '../alert-store';
import { useStaffStrings } from '../staff-lang';
import { RequestBadges } from './table-requests';
import { TableStateBadge } from './table-state-badge';

/** Thick left edge in the colour of the least-advanced dish (spec §10.4, §16.1). */
const EDGE: Record<TableTone, string> = {
  attention: 'border-l-attention',
  placed: 'border-l-status-placed',
  preparing: 'border-l-status-preparing',
  ready: 'border-l-status-ready',
  served: 'border-l-status-served',
  free: 'border-l-line',
};

const DOT: Record<'placed' | 'preparing' | 'ready' | 'served', string> = {
  placed: 'bg-status-placed',
  preparing: 'bg-status-preparing',
  ready: 'bg-status-ready',
  served: 'bg-status-served',
};

type TableCardProps = {
  table: BoardTable;
  board: Pick<Board, 'waiters'>;
  nowMs: number;
  onOpen: () => void;
};

/** One table on the board (spec §13.2): label, state, waiter, time seated, dishes by status. */
export function TableCard({ table, board, nowMs, onOpen }: TableCardProps) {
  const state = tableState(table);
  const highlighted = useHighlighted(table.id);
  const session = table.session;
  const counts = statusCounts(table);
  const waiter = session ? waiterName(board, session.assignedWaiterId) : null;
  const t = useStaffStrings();

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      data-table={table.label}
      data-state={state}
      className={cn(
        'flex h-full min-h-36 w-full flex-col gap-2 rounded-lg border border-l-8 border-line bg-surface p-3 text-left transition-shadow hover:shadow-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        EDGE[tableTone(table)],
        state === 'free' && 'bg-paper',
        highlighted && 'ring-4 ring-attention/40',
      )}
    >
      <span className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <span className="text-2xl leading-tight font-bold text-ink">
          <span className="sr-only">
            {t.table(table.label) === table.label ? '' : t.tablePrefix}
          </span>
          {table.label}
        </span>
        <TableStateBadge state={state} label={t.tableState[state]} />
        <RequestBadges requests={table.requests} />
      </span>

      {session && (
        <>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base">
            {waiter ? (
              <span className="font-medium text-ink">{waiter}</span>
            ) : (
              <span className="rounded-md border border-dashed border-attention px-1.5 font-semibold text-attention">
                {t.card.unassigned}
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-ink-muted tabular-nums">
              <Clock3 aria-hidden className="size-4" />
              <span className="sr-only">{t.card.seatedFor}</span>
              {t.elapsed(minutesSince(session.openedAt, nowMs))}
            </span>
          </span>
          <span className="mt-auto flex flex-wrap gap-x-3 gap-y-1 text-base text-ink">
            {(['placed', 'preparing', 'ready', 'served'] as const)
              .filter((status) => counts[status] > 0)
              .map((status) => (
                <span key={status} className="inline-flex items-center gap-1.5 tabular-nums">
                  <span aria-hidden className={cn('size-2.5 rounded-full', DOT[status])} />
                  {counts[status]} {t.counts[status]}
                </span>
              ))}
          </span>
        </>
      )}
    </button>
  );
}
