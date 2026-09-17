'use client';

import { ReceiptIndianRupee } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/shared/empty-state';
import { Money } from '@/components/shared/money';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { tableHeading } from '@/features/ordering/format';
import { formatElapsed, minutesSince } from '@/features/orders/board-view';
import { useServerNow } from '@/features/orders/use-server-now';

import { useBillingSessions } from '../use-billing';

/** Open tables to bill (spec §13.3 Billing), oldest first. */
export function BillingSessionsList() {
  const { data } = useBillingSessions();
  const nowMs = useServerNow(data);

  if (!data) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">Loading tables…</span>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
    );
  }

  if (data.sessions.length === 0) {
    return (
      <EmptyState
        icon={ReceiptIndianRupee}
        title="Nothing to bill yet"
        description="Tables with open orders will be listed here, ready to generate a bill."
        className="flex-1"
      />
    );
  }

  return (
    <ul aria-label="Open tables" className="flex flex-col gap-2">
      {data.sessions.map((session) => {
        const heading = tableHeading(session.tableLabel);
        return (
          <li
            key={session.sessionId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-lg font-bold text-ink">{heading}</span>
                <span className="text-sm text-ink-muted tabular-nums">
                  Seated {formatElapsed(minutesSince(session.openedAt, nowMs))} ago
                </span>
                <span className="text-sm text-ink-muted">{session.waiterName ?? 'Unassigned'}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <span className="tabular-nums">
                  {session.items} {session.items === 1 ? 'item' : 'items'}
                </span>
                <span aria-hidden>·</span>
                <Money paise={session.subtotalPaise} className="font-semibold" />
                {session.unserved > 0 && (
                  <span className="rounded-full border border-status-preparing px-2 text-ink">
                    {session.unserved} not served
                  </span>
                )}
                {session.waiting > 0 && (
                  <span className="rounded-full bg-attention/10 px-2 font-medium text-attention">
                    Waiting for approval
                  </span>
                )}
              </span>
            </div>
            <Link
              href={`/admin/billing/${session.sessionId}`}
              className={buttonVariants({ size: 'touch' })}
            >
              Bill {heading}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
