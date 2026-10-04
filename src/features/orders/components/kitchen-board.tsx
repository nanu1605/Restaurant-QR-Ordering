'use client';

import { cn } from 'cn';
import { AlarmClock } from 'lucide-react';
import { useState } from 'react';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { randomUuid } from '@/features/ordering/cart';
import { dishName, listNames, tableHeading } from '@/features/ordering/format';
import { useWakeLock } from '@/hooks/use-wake-lock';

import { formatElapsed, minutesSince, nextStatus } from '../board-view';
import {
  isLate,
  KITCHEN_COLUMNS,
  type KitchenColumn,
  type KitchenTicket,
  kitchenTickets,
} from '../kitchen';
import type { ForwardStatus } from '../schemas';
import { useBoard, useStatusChange } from '../use-board';
import { useServerNow } from '../use-server-now';

const COLUMN_EMPTY: Record<KitchenColumn, string> = {
  placed: 'No new orders',
  preparing: 'Nothing being prepared',
  ready: 'Nothing waiting to be served',
};

const EDGE: Record<KitchenColumn, string> = {
  placed: 'border-l-status-placed',
  preparing: 'border-l-status-preparing',
  ready: 'border-l-status-ready',
};

const MOVED_TO: Record<Exclude<ForwardStatus, 'served'>, string> = {
  preparing: 'Preparing',
  ready: 'Ready',
};

const TICKET_ACTION: Record<KitchenColumn, string> = {
  placed: 'Start all',
  preparing: 'Mark all ready',
  ready: 'Mark all served',
};

/**
 * Kitchen view (spec §13.2): New, Preparing and Ready columns of tickets, one
 * round for one table, oldest first. Tap a dish or the ticket button to move
 * it on; served dishes leave the view.
 */
export function KitchenBoard() {
  const { data: board } = useBoard();
  const nowMs = useServerNow(board);
  const [announcement, setAnnouncement] = useState('');
  const advance = useStatusChange();
  useWakeLock();

  if (!board) {
    return (
      <div role="status" className="grid gap-4 md:grid-cols-3">
        <span className="sr-only">Loading orders…</span>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-64 rounded-lg" />
        ))}
      </div>
    );
  }

  const columns = kitchenTickets(board);

  /**
   * Moves dishes on. The tapped control leaves the column, so focus goes to the
   * next dish on the same ticket (or the column heading), and the move is
   * announced.
   */
  const move = (request: TicketMove) => {
    const ticket = request.control.closest('article');
    const nextDish = ticket
      ? Array.from(ticket.querySelectorAll<HTMLElement>('[data-item]')).find(
          (button) => !request.ids.includes(button.dataset.item ?? ''),
        )?.dataset.item
      : undefined;
    advance.mutate({ key: randomUuid(), ids: request.ids, status: request.to });
    setAnnouncement(
      `${listNames(request.names)} ${request.to === 'served' ? 'served' : `moved to ${MOVED_TO[request.to]}`}`,
    );
    requestAnimationFrame(() => {
      const target = nextDish
        ? document.querySelector<HTMLElement>(`[data-item="${nextDish}"]`)
        : document.getElementById(`kitchen-${request.from}`);
      target?.focus();
    });
  };

  /** Scrolls the columns (not the page) to one, and moves focus there so Tab carries on in it. */
  const jumpTo = (status: KitchenColumn) => {
    const heading = document.getElementById(`kitchen-${status}`);
    const column = heading?.closest('section');
    column?.parentElement?.scrollTo({ left: column.offsetLeft - 16 });
    heading?.focus({ preventScroll: true });
  };

  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {/* Phones show one column at a time: every count stays in sight, a tap jumps to it. */}
      <div role="group" aria-label="Go to column" className="flex gap-2 md:hidden">
        {KITCHEN_COLUMNS.map(({ status, label }) => (
          <Button
            key={status}
            variant="outline"
            size="touch"
            className="flex-1 px-2"
            onClick={() => jumpTo(status)}
          >
            {label} <span className="tabular-nums">{columns[status].length}</span>
          </Button>
        ))}
      </div>
      {/* Relative, so screen-reader text in a column off to the side can't widen the page. */}
      <div className="relative -mx-4 flex snap-x snap-mandatory scroll-px-4 items-start gap-4 overflow-x-auto px-4 pb-2 md:mx-0 md:grid md:grid-cols-3 md:overflow-visible md:px-0 md:pb-0">
        {KITCHEN_COLUMNS.map(({ status, label }) => (
          <section
            key={status}
            aria-labelledby={`kitchen-${status}`}
            className="flex w-[85%] shrink-0 snap-start flex-col gap-3 md:w-auto"
          >
            <h2
              id={`kitchen-${status}`}
              tabIndex={-1}
              className="flex items-center gap-2 text-lg font-semibold text-ink focus-visible:outline-none"
            >
              {label}
              <span className="rounded-full bg-surface px-2 text-base text-ink-muted tabular-nums">
                {columns[status].length}
              </span>
            </h2>
            {columns[status].length === 0 ? (
              <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-muted">
                {COLUMN_EMPTY[status]}
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {columns[status].map((ticket) => (
                  <li key={ticket.key}>
                    <Ticket ticket={ticket} nowMs={nowMs} onMove={move} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

type TicketMove = {
  ids: string[];
  names: string[];
  from: KitchenColumn;
  to: ForwardStatus;
  control: HTMLElement;
};

function Ticket({
  ticket,
  nowMs,
  onMove,
}: {
  ticket: KitchenTicket;
  nowMs: number;
  onMove: (move: TicketMove) => void;
}) {
  const late = isLate(ticket.acceptedAt, nowMs);
  const next = nextStatus(ticket.status)!;
  const heading = tableHeading(ticket.tableLabel);
  const context = `${heading}, round ${ticket.roundNumber}`;

  return (
    <article
      aria-label={context}
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-l-8 border-line bg-surface p-3',
        late ? 'border-l-attention' : EDGE[ticket.status],
      )}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h3 className="text-xl font-bold text-ink">
          {heading}{' '}
          <span className="text-base font-medium whitespace-nowrap text-ink-muted">
            · Round {ticket.roundNumber}
          </span>
        </h3>
        <span
          className={cn(
            'inline-flex items-center gap-1 text-sm whitespace-nowrap tabular-nums',
            late ? 'font-semibold text-attention' : 'text-ink-muted',
          )}
        >
          {late && <AlarmClock aria-hidden className="size-4" />}
          {late && 'Late · '}
          {formatElapsed(minutesSince(ticket.acceptedAt, nowMs))}
        </span>
      </header>
      {ticket.note && <p className="text-sm text-ink">Note: {ticket.note}</p>}
      <ul className="flex flex-col gap-1.5">
        {ticket.items.map((item) => {
          const name = dishName(item);
          return (
            <li key={item.id}>
              <button
                type="button"
                data-item={item.id}
                onClick={(event) =>
                  onMove({
                    ids: [item.id],
                    names: [name],
                    from: ticket.status,
                    to: next,
                    control: event.currentTarget,
                  })
                }
                className="flex min-h-11 w-full items-start gap-2 rounded-md border border-line px-2 py-2 text-left hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <FoodTypeMark type={item.foodType} size="sm" className="mt-1" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-base font-medium text-ink">
                    <span className="tabular-nums">{item.quantity} ×</span>{' '}
                    {dishName({ name: item.name, variant: item.variant })}
                  </span>
                  {item.addons.length > 0 && (
                    <span className="text-base text-ink">+ {item.addons.join(', ')}</span>
                  )}
                  {item.note && <span className="text-sm text-ink-muted">Note: {item.note}</span>}
                </span>
                <span className="sr-only">
                  {' '}
                  —{' '}
                  {next === 'preparing'
                    ? 'start preparing'
                    : next === 'ready'
                      ? 'mark ready'
                      : 'mark served'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <Button
        size="touch"
        variant={ticket.status === 'ready' ? 'default' : 'outline'}
        onClick={(event) =>
          onMove({
            ids: ticket.items.map((item) => item.id),
            names: ticket.items.map((item) => dishName(item)),
            from: ticket.status,
            to: next,
            control: event.currentTarget,
          })
        }
      >
        {TICKET_ACTION[ticket.status]}
        <span className="sr-only"> for {context}</span>
      </Button>
    </article>
  );
}
