'use client';

import { BellRing, ReceiptText, type LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useOffline } from '@/features/live/live-provider';
import { updateServiceRequest } from '@/features/sessions/actions';

import type { Board, BoardRequest, BoardTable, ServiceRequestType } from '../board';
import { formatElapsed, minutesSince } from '../board-view';
import { useBoardAction } from '../use-board';

const REQUESTS: Record<ServiceRequestType, { icon: LucideIcon; badge: string; line: string }> = {
  call_waiter: { icon: BellRing, badge: 'Calling', line: 'Calling a waiter' },
  request_bill: { icon: ReceiptText, badge: 'Bill requested', line: 'Asked for the bill' },
};

/** "Calling" / "Bill requested" on a table card (spec §10.4, P9-2). */
export function RequestBadges({ requests }: { requests: BoardRequest[] }) {
  return requests.map((request) => {
    const { icon: Icon, badge } = REQUESTS[request.type];
    return (
      <span
        key={request.id}
        data-request={request.type}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-attention px-2 text-base font-semibold whitespace-nowrap text-attention"
      >
        <Icon aria-hidden className="size-4 shrink-0" strokeWidth={2.25} />
        {badge}
        {request.status === 'acknowledged' && <span className="sr-only"> (acknowledged)</span>}
      </span>
    );
  });
}

function withRequest(board: Board, id: string, status: 'acknowledged' | 'resolved'): Board {
  return {
    ...board,
    tables: board.tables.map((table) => ({
      ...table,
      requests:
        status === 'resolved'
          ? table.requests.filter((request) => request.id !== id)
          : table.requests.map((request) => (request.id === id ? { ...request, status } : request)),
    })),
  };
}

/** The table's calls and bill requests with Acknowledge / Done (P9-1). */
export function RequestsSection({ table, nowMs }: { table: BoardTable; nowMs: number }) {
  const update = useBoardAction({
    action: ({ id, status }: { id: string; status: 'acknowledged' | 'resolved' }) =>
      updateServiceRequest(id, status),
    optimistic: (board, { id, status }) => withRequest(board, id, status),
  });
  const offline = useOffline();
  if (table.requests.length === 0) return null;

  return (
    <section
      aria-label="Customer requests"
      className="flex flex-col gap-2 rounded-lg border-2 border-attention bg-surface p-3"
    >
      {table.requests.map((request) => {
        const { icon: Icon, line } = REQUESTS[request.type];
        return (
          <div key={request.id} className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-base text-ink">
              <Icon aria-hidden className="size-5 shrink-0 text-attention" />
              <span>
                <span className="font-semibold">{line}</span>
                <span className="text-ink-muted">
                  {' '}
                  · {formatElapsed(minutesSince(request.createdAt, nowMs))} ago
                  {request.status === 'acknowledged' && ' · acknowledged'}
                </span>
              </span>
            </p>
            <span className="flex gap-2">
              {request.status === 'open' && (
                <Button
                  size="touch"
                  variant="outline"
                  disabled={offline}
                  onClick={() => update.mutate({ id: request.id, status: 'acknowledged' })}
                >
                  Acknowledge<span className="sr-only">: {line.toLowerCase()}</span>
                </Button>
              )}
              <Button
                size="touch"
                disabled={offline}
                onClick={() => update.mutate({ id: request.id, status: 'resolved' })}
              >
                Done<span className="sr-only">: {line.toLowerCase()}</span>
              </Button>
            </span>
          </div>
        );
      })}
    </section>
  );
}
