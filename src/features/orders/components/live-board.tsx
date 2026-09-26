'use client';

import { LayoutGrid } from 'lucide-react';
import { useState } from 'react';

import { EmptyState } from '@/components/shared/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useWakeLock } from '@/hooks/use-wake-lock';

import {
  type BoardFilter,
  FILTER_LABELS,
  availableFilters,
  defaultFilter,
  matchesFilter,
} from '../board-view';
import { useBoard } from '../use-board';
import { useServerNow } from '../use-server-now';
import { BoardFilters } from './board-filters';
import { TableCard } from './table-card';
import { TableDrawer } from './table-drawer';

export type BoardMode = 'staff' | 'admin';

/**
 * The live board (spec §13.2 Board, §13.3 Live orders): table cards sorted by
 * table order, filter chips, and a drawer per table. Admin mode adds the
 * manager's actions (assign waiters, delete orders, revert statuses).
 */
export function LiveBoard({ mode }: { mode: BoardMode }) {
  const { data: board } = useBoard();
  const nowMs = useServerNow(board);
  const [chosenFilter, setChosenFilter] = useState<BoardFilter | null>(null);
  const [openTableId, setOpenTableId] = useState<string | null>(null);
  useWakeLock();

  if (!board) return <BoardSkeleton />;

  const filters = availableFilters(board);
  const filter =
    chosenFilter && filters.includes(chosenFilter) ? chosenFilter : defaultFilter(board);
  const counts = Object.fromEntries(
    filters.map((f) => [
      f,
      board.tables.filter((t) => matchesFilter(t, f, board.myWaiterId)).length,
    ]),
  ) as Record<BoardFilter, number>;
  const tables = board.tables.filter((table) => matchesFilter(table, filter, board.myWaiterId));

  return (
    <section aria-label="Tables" className="flex flex-col gap-3">
      <BoardFilters filters={filters} value={filter} counts={counts} onChange={setChosenFilter} />

      {board.tables.length === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title="No tables yet"
          description={
            mode === 'admin'
              ? 'Add tables in Tables & QR to see them here.'
              : 'Ask a manager to add tables in the admin panel.'
          }
        />
      ) : tables.length === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title={`No tables in “${FILTER_LABELS[filter]}”`}
          description="Choose All to see every table."
        />
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
          {tables.map((table) => (
            <li key={table.id}>
              <TableCard
                table={table}
                board={board}
                nowMs={nowMs}
                onOpen={() => setOpenTableId(table.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <TableDrawer
        board={board}
        mode={mode}
        tableId={openTableId}
        nowMs={nowMs}
        onClose={() => setOpenTableId(null)}
      />
    </section>
  );
}

function BoardSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="sr-only">Loading tables…</span>
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-11 w-28 rounded-full" />
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-36 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
