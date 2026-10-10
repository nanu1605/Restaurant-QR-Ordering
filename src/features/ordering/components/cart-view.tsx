'use client';

import { ArrowLeft, CircleCheck, Plus, ShoppingBag } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/shared/empty-state';
import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Money, withRupee } from '@/components/shared/money';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatINR } from '@/lib/money';

import { placeOrder } from '../actions';
import {
  cartTotalPaise,
  EMPTY_CART,
  lineKey,
  lineLabel,
  randomUuid,
  refusedKeys,
  removeLines,
  setLineNote,
  setLineQuantity,
  setOrderNote,
  toOrderLines,
  type CartLine,
} from '../cart';
import { MAX_LINE_NOTE, MAX_ORDER_NOTE } from '../limits';
import type { Strings } from '../strings';
import type { CustomerTable } from '../types';
import { CustomerSkeleton } from './customer-skeleton';
import { useStrings } from './lang-provider';
import { OrderingUnavailable } from './ordering-unavailable';
import { QuantityStepper } from './quantity-stepper';
import { useHydrated } from '@/hooks/use-hydrated';
import { useReconciledCart } from './use-reconciled-cart';

type CartViewProps = { qrToken: string; table: CustomerTable };

/** Review and place the order (spec §13.1 Cart page). */
export function CartView({ qrToken, table }: CartViewProps) {
  const router = useRouter();
  const ids = useId();
  const t = useStrings();
  // The cart lives in localStorage: until the browser has read it, show a
  // placeholder rather than claiming the cart is empty.
  const hydrated = useHydrated();
  const [cart, update] = useReconciledCart(qrToken, table.menu);
  // Made when the page loads and kept across retries, so a resend after a
  // network error can never create a second order (spec §9.3).
  const [idempotencyKey, setIdempotencyKey] = useState(randomUuid);
  // With the words it was written in: switching language hides it.
  const [error, setError] = useState<{ text: string; in: Strings } | null>(null);
  const fail = (text: string) => setError({ text, in: t });
  const [placed, setPlaced] = useState(false);
  const [pending, startTransition] = useTransition();
  const submitting = useRef(false);

  const menuHref = `/t/${qrToken}`;

  function submit() {
    if (submitting.current || cart.lines.length === 0) return;
    submitting.current = true;
    setError(null);

    const submitted = cart.lines;
    startTransition(async () => {
      try {
        const result = await placeOrder(qrToken, {
          idempotencyKey,
          lines: toOrderLines(cart),
          note: cart.note,
        });
        if (result.ok) {
          // Show "Order placed" (not an empty cart) while the orders page loads.
          setPlaced(true);
          update(() => EMPTY_CART);
          setIdempotencyKey(randomUuid());
          toast.success(
            result.data.status === 'pending_approval' ? t.cart.placedWaiting : t.cart.placed,
          );
          router.push(`/t/${qrToken}/orders`);
          return;
        }
        if (result.unavailableLines) {
          const keys = refusedKeys(submitted, result.unavailableLines);
          let removed: string[] = [];
          update((current) => {
            const next = removeLines(current, keys);
            removed = next.removed;
            return next.cart;
          });
          fail(
            removed.length > 0
              ? `${t.unavailable(removed)} ${t.cart.checkAndPlaceAgain}`
              : result.error,
          );
          return;
        }
        fail(result.error);
      } catch {
        // Nothing may have reached the restaurant, or the order did but the
        // reply was lost: retrying with the same key is safe either way.
        fail(t.networkError);
      } finally {
        submitting.current = false;
      }
    });
  }

  const errorAlert = error?.in === t && (
    <p role="alert" className="text-sm font-medium text-status-void">
      {error.text}
    </p>
  );

  return (
    <main className="flex flex-1 flex-col gap-4 px-4 pt-3 pb-10">
      <div className="flex items-center gap-1">
        <Link
          href={menuHref}
          aria-label={t.cart.back}
          className={buttonVariants({ variant: 'ghost', size: 'icon-touch', className: '-ml-3' })}
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <h1 className="text-xl font-semibold text-ink">{t.cart.title}</h1>
      </div>

      {!table.canOrder && <OrderingUnavailable />}

      {placed ? (
        <p role="status" className="flex items-center gap-2 py-6 text-base text-ink">
          <CircleCheck aria-hidden className="size-5 text-status-served" />
          {t.cart.opening}
        </p>
      ) : !hydrated ? (
        <CustomerSkeleton rows={2} />
      ) : cart.lines.length === 0 ? (
        <>
          {/* e.g. every dish ran out just as the order was placed */}
          {errorAlert}
          <EmptyState
            icon={ShoppingBag}
            title={t.cart.empty}
            description={t.cart.emptyHint}
            action={
              <Link href={menuHref} className={buttonVariants({ size: 'touch' })}>
                {t.cart.browse}
              </Link>
            }
          />
        </>
      ) : (
        <>
          <ul className="divide-y divide-line border-y border-line">
            {cart.lines.map((line) => (
              <CartLineRow
                key={lineKey(line)}
                line={line}
                onQuantity={(quantity) =>
                  update((current) => setLineQuantity(current, lineKey(line), quantity))
                }
                onNote={(note) => update((current) => setLineNote(current, lineKey(line), note))}
              />
            ))}
          </ul>

          <Link
            href={menuHref}
            className={buttonVariants({
              variant: 'outline',
              size: 'touch',
              className: 'self-start',
            })}
          >
            <Plus aria-hidden />
            {t.cart.addMore}
          </Link>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-note`} className="text-sm font-semibold text-ink">
              {t.cart.orderNote}{' '}
              <span className="font-normal text-ink-muted">{t.cart.optional}</span>
            </label>
            <Textarea
              id={`${ids}-note`}
              value={cart.note}
              onChange={(event) => update((current) => setOrderNote(current, event.target.value))}
              maxLength={MAX_ORDER_NOTE}
              rows={2}
              placeholder={t.cart.orderNoteExample}
              className="text-base"
            />
          </div>

          <div className="flex flex-col gap-1 rounded-lg bg-paper px-4 py-3">
            <p className="flex items-baseline justify-between gap-3 text-base font-semibold text-ink">
              <span>{t.cart.estimatedTotal}</span>
              <Money paise={cartTotalPaise(cart)} fraction="auto" />
            </p>
            <p className="text-sm text-ink-muted">{t.cart.taxesLater}</p>
          </div>

          {table.canOrder && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-ink">{t.cart.cancelNotice(table.cancelWindowSeconds)}</p>
              {errorAlert}
              <Button size="touch" className="w-full" onClick={submit} disabled={pending}>
                {pending ? t.cart.placing : t.cart.place}
              </Button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

type CartLineRowProps = {
  line: CartLine;
  onQuantity: (quantity: number) => void;
  onNote: (note: string) => void;
};

function CartLineRow({ line, onQuantity, onNote }: CartLineRowProps) {
  // Once shown (or when the dish already has a note), the note field stays put,
  // even when it is cleared to type a new one.
  const [editingNote, setEditingNote] = useState(line.note !== '');
  const t = useStrings();
  const label = lineLabel(line);

  return (
    <li className="flex flex-col gap-2 py-4">
      <div className="flex items-start gap-2">
        <FoodTypeMark
          type={line.foodType}
          label={t.foodType[line.foodType]}
          size="sm"
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium text-ink">
            {line.name}
            {line.variantName && <span className="text-ink-muted"> · {line.variantName}</span>}
            {line.addonNames?.length ? (
              <span className="block text-sm text-ink-muted">+ {line.addonNames.join(', ')}</span>
            ) : null}
          </p>
          <p className="text-sm text-ink-muted tabular-nums">
            {withRupee(t.cart.each(formatINR(line.unitPricePaise, { fraction: 'auto' })))}
          </p>
        </div>
        <Money
          paise={line.unitPricePaise * line.quantity}
          fraction="auto"
          className="text-base font-semibold text-ink"
        />
      </div>
      <div className="flex items-center justify-between gap-3 pl-6">
        {editingNote ? (
          <Input
            value={line.note}
            onChange={(event) => onNote(event.target.value)}
            maxLength={MAX_LINE_NOTE}
            placeholder={t.cart.dishNoteExample}
            aria-label={t.cart.noteFor(label)}
            className="h-11 flex-1 text-base"
            autoFocus={line.note === ''}
          />
        ) : (
          // Ink, not the accent colour: accents can be too light for text on white.
          <Button
            variant="ghost"
            className="h-11 px-2 text-sm text-ink underline underline-offset-4"
            onClick={() => setEditingNote(true)}
            aria-label={t.cart.addNoteFor(label)}
          >
            {t.cart.addNote}
          </Button>
        )}
        <QuantityStepper value={line.quantity} onChange={onQuantity} itemName={label} />
      </div>
    </li>
  );
}
