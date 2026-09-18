'use client';

import { Hand } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Money } from '@/components/shared/money';
import { buttonVariants } from '@/components/ui/button';
import { statusCounts } from '@/features/orders/board-view';
import { useBoard } from '@/features/orders/use-board';
import { UnassignedQueue } from '@/features/sessions/components/unassigned-queue';
import { WaiterStrip } from '@/features/sessions/components/waiter-strip';
import { useTodaySales } from '@/features/reports/use-today-sales';

import { MiniBoard } from './mini-board';

/**
 * Admin dashboard (spec §13.3): today's business-day sales, what is happening
 * right now and what needs attention. Subscription warnings come from the
 * panel's own banner (docs/DECISIONS.md P6-11, P6-12).
 */
export function Dashboard() {
  const { data: board } = useBoard();
  const { data: sales } = useTodaySales();

  const openTables = board?.tables.filter((table) => table.session) ?? [];
  const dishes = openTables.reduce((total, table) => {
    const counts = statusCounts(table);
    return total + counts.placed + counts.preparing + counts.ready;
  }, 0);
  const waiting = openTables.reduce(
    (total, table) => total + (table.session?.waitingCount ?? 0),
    0,
  );

  return (
    <div className="flex flex-col gap-4">
      <dl
        aria-label="Today"
        className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-5"
      >
        <Stat label="Sales today">{sales ? <Money paise={sales.summary.totalPaise} /> : '—'}</Stat>
        <Stat label="Bills">{sales ? sales.summary.bills : '—'}</Stat>
        <Stat label="Average bill">
          {sales ? <Money paise={sales.summary.averagePaise} /> : '—'}
        </Stat>
        <Stat label="Open tables">{board ? openTables.length : '—'}</Stat>
        <Stat label="Dishes in progress">{board ? dishes : '—'}</Stat>
      </dl>

      {waiting > 0 && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-attention bg-surface p-3 text-base text-ink"
        >
          <Hand aria-hidden className="size-5 shrink-0 text-attention" />
          {waiting === 1
            ? '1 order is waiting for approval'
            : `${waiting} orders are waiting for approval`}
          <Link
            href="/admin/live"
            className={buttonVariants({ variant: 'outline', size: 'touch' })}
          >
            Review orders
          </Link>
        </p>
      )}

      <UnassignedQueue />
      <WaiterStrip />
      <MiniBoard />
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="text-lg font-semibold text-ink tabular-nums">{children}</dd>
    </div>
  );
}
