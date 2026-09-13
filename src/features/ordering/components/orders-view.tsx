'use client';

import { cn } from 'cn';
import { CircleCheck, Clock3, Plus, ReceiptText } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/shared/empty-state';
import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { StatusChip } from '@/components/shared/status-chip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { isVoidStatus } from '@/lib/order-status';

import { cancelOrderItem } from '../actions';
import { CUSTOMER_STATUS_LABELS, formatClockTime, formatCountdown, NETWORK_ERROR } from '../format';
import { SESSION_POLL_MS } from '../limits';
import type { CustomerOrderItem, CustomerRound, CustomerSessionView } from '../types';
import { useNow } from './use-now';

type OrdersViewProps = { qrToken: string; initial: CustomerSessionView };

/**
 * The table's orders (spec §13.1 Orders page), polled every 10 s while the page
 * is visible. Every phone at the table sees every round; only the phone that
 * ordered a dish can cancel it, within the restaurant's window.
 */
export function OrdersView({ qrToken, initial }: OrdersViewProps) {
  const [session, setSession] = useState(initial);
  // Server clock vs this phone's clock, so countdowns survive a wrong phone clock.
  const [clockSync, setClockSync] = useState<{ server: number; client: number } | null>(null);
  const [stale, setStale] = useState(false);
  const [confirming, setConfirming] = useState<CustomerOrderItem | null>(null);
  const [cancelling, startCancel] = useTransition();
  const now = useNow();

  const menuHref = `/t/${qrToken}`;

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/t/${qrToken}/session`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = (await response.json()) as CustomerSessionView;
      setSession(next);
      setClockSync({ server: Date.parse(next.now), client: Date.now() });
      setStale(false);
    } catch {
      setStale(true);
    }
  }, [qrToken]);

  useEffect(() => {
    // The first poll runs straight away: it also syncs the clocks for the
    // cancel countdowns.
    const first = window.setTimeout(() => void refresh(), 0);
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, SESSION_POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  const serverNow = clockSync && now !== null ? clockSync.server + (now - clockSync.client) : null;

  function cancelMs(item: CustomerOrderItem): number | null {
    if (!item.cancellableUntil) return null;
    if (serverNow === null) return Number.POSITIVE_INFINITY;
    const left = Date.parse(item.cancellableUntil) - serverNow;
    return left > 0 ? left : null;
  }

  function confirmCancel() {
    const item = confirming;
    if (!item) return;
    startCancel(async () => {
      try {
        const result = await cancelOrderItem(qrToken, item.id);
        if (result.ok) toast.success(`${item.name} cancelled.`);
        else toast.error(result.error);
      } catch {
        toast.error(NETWORK_ERROR);
      }
      setConfirming(null);
      await refresh();
    });
  }

  const rounds = session.rounds ?? [];
  const orderedHere = rounds.some((round) => round.isMine);
  const waiting = rounds.some(
    (round) =>
      round.status === 'pending_approval' && round.items.some((item) => item.status === 'placed'),
  );

  return (
    <main className="flex flex-1 flex-col gap-4 px-4 pt-4 pb-10">
      <h1 className="text-xl font-semibold text-ink">Your table’s orders</h1>

      {session.lastSessionBilled && !orderedHere ? (
        <div
          role="status"
          className="flex flex-col items-start gap-3 rounded-lg border border-status-served/40 bg-status-served/5 p-4"
        >
          <p className="flex items-start gap-2 text-base text-ink">
            <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-status-served" />
            Your bill has been generated. Please pay at the counter or to your server. Thank you!
          </p>
          {session.canOrder && (
            <Link href={menuHref} className={buttonVariants({ size: 'touch' })}>
              Start a new order
            </Link>
          )}
        </div>
      ) : rounds.length === 0 ? (
        <EmptyState
          icon={ReceiptText}
          title="No orders yet"
          description="Dishes you order from this table appear here."
          action={
            <Link href={menuHref} className={buttonVariants({ size: 'touch' })}>
              Browse the menu
            </Link>
          }
        />
      ) : (
        <>
          {waiting && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-lg border border-attention/40 bg-attention/5 px-4 py-3 text-sm font-medium text-ink"
            >
              <Clock3 aria-hidden className="mt-0.5 size-4 shrink-0 text-attention" />
              Waiting for staff to confirm your order.
            </p>
          )}

          <ol className="flex flex-col gap-4">
            {rounds.map((round) => (
              <RoundCard
                key={round.id}
                round={round}
                timezone={session.timezone}
                cancelMs={cancelMs}
                onCancel={setConfirming}
              />
            ))}
          </ol>

          {session.canOrder && (
            <Link
              href={menuHref}
              className={buttonVariants({ size: 'touch', className: 'w-full' })}
            >
              <Plus aria-hidden />
              Order more
            </Link>
          )}
        </>
      )}

      {/* Always present, so a failed refresh is announced when it happens. */}
      <p role="status" className="text-center text-sm text-ink-muted empty:hidden">
        {stale ? 'Couldn’t refresh the orders. Trying again…' : ''}
      </p>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {confirming?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The kitchen won’t make it, and it won’t be on your bill.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="touch">Keep it</AlertDialogCancel>
            <AlertDialogAction size="touch" onClick={confirmCancel} disabled={cancelling}>
              Cancel dish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

type RoundCardProps = {
  round: CustomerRound;
  timezone: string;
  cancelMs: (item: CustomerOrderItem) => number | null;
  onCancel: (item: CustomerOrderItem) => void;
};

function RoundCard({ round, timezone, cancelMs, onCancel }: RoundCardProps) {
  const headingId = `round-${round.id}`;
  return (
    <li>
      <section aria-labelledby={headingId} className="rounded-lg border border-line bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 id={headingId} className="text-base font-semibold text-ink tabular-nums">
            Round {round.roundNumber} · {formatClockTime(round.placedAt, timezone)}
          </h2>
          {round.isMine && (
            <span className="rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-ink-muted">
              From this phone
            </span>
          )}
        </header>

        {round.status === 'rejected' && (
          <p className="border-b border-line px-4 py-2 text-sm font-medium text-status-void">
            Staff couldn’t confirm this order{round.rejectReason ? `: ${round.rejectReason}` : '.'}
          </p>
        )}
        {round.status === 'removed' && (
          <p className="border-b border-line px-4 py-2 text-sm font-medium text-status-void">
            Removed by staff{round.removedReason ? `: ${round.removedReason}` : '.'}
          </p>
        )}
        {round.customerNote && (
          <p className="border-b border-line px-4 py-2 text-sm text-ink-muted">
            Note: {round.customerNote}
          </p>
        )}

        <ul className="divide-y divide-line">
          {round.items.map((item) => {
            const left = round.isMine ? cancelMs(item) : null;
            const struck = isVoidStatus(item.status);
            const label = item.variant ? `${item.name} (${item.variant})` : item.name;
            return (
              <li key={item.id} className="flex items-start gap-3 px-4 py-3">
                <FoodTypeMark type={item.foodType} size="sm" className="mt-1" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p
                    className={cn(
                      'text-base text-ink',
                      struck && 'text-ink-muted line-through decoration-status-void',
                    )}
                  >
                    <span className="tabular-nums">{item.quantity} ×</span> {label}
                  </p>
                  {item.note && <p className="text-sm text-ink-muted">Note: {item.note}</p>}
                  {item.status === 'removed' && (
                    <p className="text-sm text-status-void">
                      Removed by staff{item.removedReason ? `: ${item.removedReason}` : ''}
                    </p>
                  )}
                  {left !== null && (
                    // The dish name is spoken, and so is the time left (visible as "· 1:42").
                    <Button
                      variant="outline"
                      size="touch"
                      className="mt-1 self-start"
                      onClick={() => onCancel(item)}
                    >
                      Cancel<span className="sr-only"> {label}</span>
                      {Number.isFinite(left) && (
                        <span className="text-ink-muted tabular-nums">
                          · {formatCountdown(left)}
                        </span>
                      )}
                    </Button>
                  )}
                </div>
                <StatusChip status={item.status} label={CUSTOMER_STATUS_LABELS[item.status]} />
              </li>
            );
          })}
        </ul>
      </section>
    </li>
  );
}
