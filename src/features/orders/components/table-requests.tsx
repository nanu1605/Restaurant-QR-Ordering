'use client';

import { Button } from '@/components/ui/button';
import { useOffline } from '@/features/live/live-provider';
import { updateServiceRequest } from '@/features/sessions/actions';

import type { Board, BoardTable } from '../board';
import { minutesSince } from '../board-view';
import { useStaffStrings } from '../staff-lang';
import { useBoardAction } from '../use-board';
import { REQUESTS, RequestBadges as Badges } from './request-badges';

/** The table's request badges in the worker panel's words. */
export function RequestBadges({ requests }: { requests: BoardTable['requests'] }) {
  return <Badges requests={requests} words={useStaffStrings().requests} />;
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
  const t = useStaffStrings();
  if (table.requests.length === 0) return null;

  return (
    <section
      aria-label={t.requests.section}
      className="flex flex-col gap-2 rounded-lg border-2 border-attention bg-surface p-3"
    >
      {table.requests.map((request) => {
        const { icon: Icon } = REQUESTS[request.type];
        const { line } = t.requests[request.type];
        return (
          <div key={request.id} className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-base text-ink">
              <Icon aria-hidden className="size-5 shrink-0 text-attention" />
              <span>
                <span className="font-semibold">{line}</span>
                <span className="text-ink-muted">
                  {' '}
                  · {t.requests.ago(t.elapsed(minutesSince(request.createdAt, nowMs)))}
                  {request.status === 'acknowledged' && t.requests.acknowledgedNote}
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
                  {t.requests.acknowledge}
                  <span className="sr-only">: {line.toLowerCase()}</span>
                </Button>
              )}
              <Button
                size="touch"
                disabled={offline}
                onClick={() => update.mutate({ id: request.id, status: 'resolved' })}
              >
                {t.requests.done}
                <span className="sr-only">: {line.toLowerCase()}</span>
              </Button>
            </span>
          </div>
        );
      })}
    </section>
  );
}
