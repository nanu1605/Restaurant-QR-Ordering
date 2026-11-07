'use client';

import { cn } from 'cn';
import { CircleCheck, Clock3, Plus, ReceiptText } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useState, useTransition } from 'react';
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
import { currentDeploymentId } from '@/features/new-version/stale';
import { isVoidStatus } from '@/lib/order-status';

import { cancelOrderItem } from '../actions';
import { dishName, formatClockTime, formatCountdown } from '../format';
import { SESSION_POLL_MS } from '../limits';
import type { CustomerOrderItem, CustomerRound, CustomerSessionView } from '../types';
import { useStrings } from './lang-provider';
import { ServiceRequestButton } from './service-request-button';
import { useNow } from '@/hooks/use-now';

type OrdersViewProps = {
  qrToken: string;
  initial: CustomerSessionView;
  /** The customer copy of this phone's bill, drawn on the server (docs/DECISIONS.md P11-2). */
  bill?: ReactNode;
};

/**
 * The table's orders (spec §13.1 Orders page), polled every 10 s while the page
 * is visible. Every phone at the table sees every round; only the phone that
 * ordered a dish can cancel it, within the restaurant's window.
 */
export function OrdersView({ qrToken, initial, bill }: OrdersViewProps) {
  const [session, setSession] = useState(initial);
  // A fresh server render (e.g. after switching language, which renames dishes)
  // replaces the polled copy without remounting the rest of the view.
  const [rendered, setRendered] = useState(initial);
  if (initial !== rendered) {
    setRendered(initial);
    setSession(initial);
  }
  // Server clock vs this phone's clock, so countdowns survive a wrong phone clock.
  const [clockSync, setClockSync] = useState<{ server: number; client: number } | null>(null);
  const [stale, setStale] = useState(false);
  const [confirming, setConfirming] = useState<CustomerOrderItem | null>(null);
  const [cancelling, startCancel] = useTransition();
  const now = useNow();
  const t = useStrings();
  const router = useRouter();

  const menuHref = `/t/${qrToken}`;
  // The bill this server render drew; payment doesn't change it, only a new bill or a void.
  const drawnInvoice = rendered.bill?.invoiceNumber ?? null;

  const refresh = useCallback(async () => {
    try {
      // Asks the deployment that served this page, as Next.js does for its own
      // requests (docs/DECISIONS.md P10-11); unset locally and in CI.
      const deployment = currentDeploymentId();
      const response = await fetch(`/t/${qrToken}/session`, {
        cache: 'no-store',
        headers: deployment ? { 'x-deployment-id': deployment } : undefined,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = (await response.json()) as CustomerSessionView;
      // A new or voided bill: the page draws the bill again.
      if ((next.bill?.invoiceNumber ?? null) !== drawnInvoice) router.refresh();
      setSession(next);
      setClockSync({ server: Date.parse(next.now), client: Date.now() });
      setStale(false);
    } catch {
      setStale(true);
    }
  }, [qrToken, drawnInvoice, router]);

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
        if (result.ok) toast.success(t.orders.cancelled(item.name));
        else toast.error(result.error);
      } catch {
        toast.error(t.networkError);
      }
      setConfirming(null);
      await refresh();
    });
  }

  const rounds = session.rounds ?? [];
  const orderedHere = rounds.some((round) => round.isMine);
  const billed = session.lastSessionBilled && !orderedHere;
  // No bill: voided, or none of this phone's dishes made it onto the bill.
  const billMessage = !billed
    ? ''
    : !session.bill
      ? t.orders.billClosed
      : session.bill.paid
        ? t.orders.billPaid
        : t.orders.billed;
  const waiting = rounds.some(
    (round) =>
      round.status === 'pending_approval' && round.items.some((item) => item.status === 'placed'),
  );

  return (
    <main className="flex flex-1 flex-col gap-4 px-4 pt-4 pb-10">
      <h1 className="text-xl font-semibold text-ink">{t.orders.title}</h1>
      {/* Always present, so the bill arriving (or being paid) while the guest watches is
          announced; the visible copy below is hidden from screen readers to avoid reading it twice. */}
      <p role="status" className="sr-only">
        {billMessage}
      </p>

      {billed ? (
        <>
          <div className="flex flex-col items-start gap-3 rounded-lg border border-status-served/40 bg-status-served/5 p-4">
            <p aria-hidden className="flex items-start gap-2 text-base text-ink">
              <CircleCheck className="mt-0.5 size-5 shrink-0 text-status-served" />
              {billMessage}
            </p>
            {session.canOrder && (
              <Link href={menuHref} className={buttonVariants({ size: 'touch' })}>
                {t.orders.newOrder}
              </Link>
            )}
          </div>
          {/* Only the bill this render drew; a new one appears once the refresh lands. */}
          {drawnInvoice !== null && session.bill?.invoiceNumber === drawnInvoice && bill && (
            <section aria-labelledby="your-bill" className="flex flex-col gap-2">
              {/* Not a heading: the bill's own title (Tax Invoice…) is the section's heading. */}
              <p id="your-bill" className="text-base font-semibold text-ink">
                {t.orders.yourBill}
              </p>
              {bill}
            </section>
          )}
        </>
      ) : rounds.length === 0 ? (
        <EmptyState
          icon={ReceiptText}
          title={t.orders.none}
          description={t.orders.noneHint}
          action={
            <Link href={menuHref} className={buttonVariants({ size: 'touch' })}>
              {t.cart.browse}
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
              {t.orders.waiting}
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
              {t.orders.orderMore}
            </Link>
          )}
          {rounds.some((round) => round.status === 'accepted') && (
            <ServiceRequestButton qrToken={qrToken} type="request_bill" className="w-full" />
          )}
        </>
      )}

      {/* Always present, so a failed refresh is announced when it happens. */}
      <p role="status" className="text-center text-sm text-ink-muted empty:hidden">
        {stale ? t.orders.stale : ''}
      </p>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.orders.cancelTitle(confirming?.name ?? '')}</AlertDialogTitle>
            <AlertDialogDescription>{t.orders.cancelBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="touch">{t.orders.keep}</AlertDialogCancel>
            <AlertDialogAction size="touch" onClick={confirmCancel} disabled={cancelling}>
              {t.orders.cancelDish}
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
  const t = useStrings();
  const headingId = `round-${round.id}`;
  return (
    <li>
      <section aria-labelledby={headingId} className="rounded-lg border border-line bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 id={headingId} className="text-base font-semibold text-ink tabular-nums">
            {t.orders.round(round.roundNumber, formatClockTime(round.placedAt, timezone))}
          </h2>
          {round.isMine && (
            <span className="rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-ink-muted">
              {t.orders.fromThisPhone}
            </span>
          )}
        </header>

        {round.status === 'rejected' && (
          <p className="border-b border-line px-4 py-2 text-sm font-medium text-status-void">
            {t.orders.rejected(round.rejectReason)}
          </p>
        )}
        {round.status === 'removed' && (
          <p className="border-b border-line px-4 py-2 text-sm font-medium text-status-void">
            {t.orders.removed(round.removedReason)}
          </p>
        )}
        {round.customerNote && (
          <p className="border-b border-line px-4 py-2 text-sm text-ink-muted">
            {t.orders.note(round.customerNote)}
          </p>
        )}

        <ul className="divide-y divide-line">
          {round.items.map((item) => {
            const left = round.isMine ? cancelMs(item) : null;
            const struck = isVoidStatus(item.status);
            const label = dishName(item);
            return (
              <li key={item.id} className="flex items-start gap-3 px-4 py-3">
                <FoodTypeMark
                  type={item.foodType}
                  label={t.foodType[item.foodType]}
                  size="sm"
                  className="mt-1"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p
                    className={cn(
                      'text-base text-ink',
                      struck && 'text-ink-muted line-through decoration-status-void',
                    )}
                  >
                    <span className="tabular-nums">{item.quantity} ×</span> {label}
                  </p>
                  {item.note && (
                    <p className="text-sm text-ink-muted">{t.orders.note(item.note)}</p>
                  )}
                  {item.status === 'removed' && (
                    <p className="text-sm text-status-void">
                      {t.orders.removed(item.removedReason)}
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
                      {t.orders.cancel}
                      <span className="sr-only"> {label}</span>
                      {Number.isFinite(left) && (
                        <span className="text-ink-muted tabular-nums">
                          · {formatCountdown(left)}
                        </span>
                      )}
                    </Button>
                  )}
                </div>
                <StatusChip status={item.status} label={t.status[item.status]} />
              </li>
            );
          })}
        </ul>
      </section>
    </li>
  );
}
