'use client';

import { cn } from 'cn';
import { CircleCheck, Timer } from 'lucide-react';
import Link from 'next/link';

import { waiterAvailability } from '@/features/orders/board-view';
import { useBoard } from '@/features/orders/use-board';
import { waiterStatus } from '@/features/waiters/status';

/** Waiter availability strip (spec §13.3): a chip per on-duty waiter. */
export function WaiterStrip() {
  const { data: board } = useBoard();
  if (!board) return null;
  const waiters = waiterAvailability(board).filter((waiter) => waiter.status !== 'off_duty');

  return (
    <section aria-labelledby="waiter-strip-heading" className="flex flex-col gap-2">
      <h2 id="waiter-strip-heading" className="text-sm font-semibold text-ink-muted">
        Waiters on duty
      </h2>
      {waiters.length === 0 ? (
        <p className="text-sm text-ink">
          No waiters on duty.{' '}
          <Link
            href="/admin/waiters"
            className="font-medium text-brand underline underline-offset-4"
          >
            Switch someone on duty in Waiters
          </Link>
          .
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {waiters.map((waiter) => {
            const status = waiterStatus(
              { onDuty: waiter.onDuty, openTables: waiter.tables },
              board.settings.maxTablesPerWaiter,
            );
            const Icon = status.tone === 'busy' ? Timer : CircleCheck;
            return (
              <li
                key={waiter.id}
                data-waiter={waiter.name}
                data-status={status.tone}
                className={cn(
                  'inline-flex h-10 items-center gap-2 rounded-full border px-3 text-sm',
                  status.tone === 'busy'
                    ? 'border-status-preparing bg-status-preparing-fill text-status-preparing-foreground'
                    : 'border-status-served bg-status-served-fill text-status-served-foreground',
                )}
              >
                <Icon aria-hidden className="size-4" />
                <span className="font-semibold">{waiter.name}</span>
                <span>· {status.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
