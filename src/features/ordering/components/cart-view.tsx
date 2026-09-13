'use client';

import { ArrowLeft, CircleCheck, Plus, ShoppingBag } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/shared/empty-state';
import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Money } from '@/components/shared/money';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatINR } from '@/lib/money';

import { placeOrder } from '../actions';
import {
  cartTotalPaise,
  EMPTY_CART,
  lineKey,
  randomUuid,
  removeItems,
  setLineNote,
  setLineQuantity,
  setOrderNote,
  toOrderLines,
  type CartLine,
} from '../cart';
import { cancelNotice, NETWORK_ERROR, unavailableMessage } from '../format';
import { MAX_LINE_NOTE, MAX_ORDER_NOTE } from '../limits';
import type { CustomerTable } from '../types';
import { CustomerSkeleton } from './customer-skeleton';
import { OrderingUnavailable } from './ordering-unavailable';
import { QuantityStepper } from './quantity-stepper';
import { useHydrated } from './use-hydrated';
import { useReconciledCart } from './use-reconciled-cart';

type CartViewProps = { qrToken: string; table: CustomerTable };

/** Review and place the order (spec §13.1 Cart page). */
export function CartView({ qrToken, table }: CartViewProps) {
  const router = useRouter();
  const ids = useId();
  // The cart lives in localStorage: until the browser has read it, show a
  // placeholder rather than claiming the cart is empty.
  const hydrated = useHydrated();
  const [cart, update] = useReconciledCart(qrToken, table.menu);
  // Made when the page loads and kept across retries, so a resend after a
  // network error can never create a second order (spec §9.3).
  const [idempotencyKey, setIdempotencyKey] = useState(randomUuid);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState(false);
  const [pending, startTransition] = useTransition();
  const submitting = useRef(false);

  const menuHref = `/t/${qrToken}`;

  function submit() {
    if (submitting.current || cart.lines.length === 0) return;
    submitting.current = true;
    setError(null);

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
            result.data.status === 'pending_approval'
              ? 'Order placed. Waiting for staff to confirm it.'
              : 'Order placed.',
          );
          router.push(`/t/${qrToken}/orders`);
          return;
        }
        if (result.unavailableItemIds) {
          let removed: string[] = [];
          update((current) => {
            const next = removeItems(current, result.unavailableItemIds ?? []);
            removed = next.removed;
            return next.cart;
          });
          setError(
            removed.length > 0
              ? `${unavailableMessage(removed)} Check your order and place it again.`
              : result.error,
          );
          return;
        }
        setError(result.error);
      } catch {
        // Nothing may have reached the restaurant, or the order did but the
        // reply was lost: retrying with the same key is safe either way.
        setError(NETWORK_ERROR);
      } finally {
        submitting.current = false;
      }
    });
  }

  const errorAlert = error && (
    <p role="alert" className="text-sm font-medium text-status-void">
      {error}
    </p>
  );

  return (
    <main className="flex flex-1 flex-col gap-4 px-4 pt-3 pb-10">
      <div className="flex items-center gap-1">
        <Link
          href={menuHref}
          aria-label="Back to the menu"
          className={buttonVariants({ variant: 'ghost', size: 'icon-touch', className: '-ml-3' })}
        >
          <ArrowLeft aria-hidden className="size-5" />
        </Link>
        <h1 className="text-xl font-semibold text-ink">Your order</h1>
      </div>

      {!table.canOrder && <OrderingUnavailable />}

      {placed ? (
        <p role="status" className="flex items-center gap-2 py-6 text-base text-ink">
          <CircleCheck aria-hidden className="size-5 text-status-served" />
          Order placed. Opening your table’s orders…
        </p>
      ) : !hydrated ? (
        <CustomerSkeleton rows={2} />
      ) : cart.lines.length === 0 ? (
        <>
          {/* e.g. every dish ran out just as the order was placed */}
          {errorAlert}
          <EmptyState
            icon={ShoppingBag}
            title="Your cart is empty"
            description="Add dishes from the menu to place an order."
            action={
              <Link href={menuHref} className={buttonVariants({ size: 'touch' })}>
                Browse the menu
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
            Add more dishes
          </Link>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-note`} className="text-sm font-semibold text-ink">
              Note for the whole order{' '}
              <span className="font-normal text-ink-muted">(optional)</span>
            </label>
            <Textarea
              id={`${ids}-note`}
              value={cart.note}
              onChange={(event) => update((current) => setOrderNote(current, event.target.value))}
              maxLength={MAX_ORDER_NOTE}
              rows={2}
              placeholder="e.g. we’re celebrating a birthday"
              className="text-base"
            />
          </div>

          <div className="flex flex-col gap-1 rounded-lg bg-paper px-4 py-3">
            <p className="flex items-baseline justify-between gap-3 text-base font-semibold text-ink">
              <span>Estimated total</span>
              <Money paise={cartTotalPaise(cart)} fraction="auto" />
            </p>
            <p className="text-sm text-ink-muted">
              Taxes and charges, if any, are added to the final bill.
            </p>
          </div>

          {table.canOrder && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-ink">{cancelNotice(table.cancelWindowSeconds)}</p>
              {errorAlert}
              <Button size="touch" className="w-full" onClick={submit} disabled={pending}>
                {pending ? 'Placing order…' : 'Place order'}
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
  const label = line.variantName ? `${line.name} (${line.variantName})` : line.name;

  return (
    <li className="flex flex-col gap-2 py-4">
      <div className="flex items-start gap-2">
        <FoodTypeMark type={line.foodType} size="sm" className="mt-1" />
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium text-ink">
            {line.name}
            {line.variantName && <span className="text-ink-muted"> · {line.variantName}</span>}
          </p>
          <p className="text-sm text-ink-muted tabular-nums">
            {formatINR(line.unitPricePaise, { fraction: 'auto' })} each
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
            placeholder="e.g. less spicy"
            aria-label={`Note for ${label}`}
            className="h-11 flex-1 text-base"
            autoFocus={line.note === ''}
          />
        ) : (
          // Ink, not the accent colour: accents can be too light for text on white.
          <Button
            variant="ghost"
            className="h-11 px-2 text-sm text-ink underline underline-offset-4"
            onClick={() => setEditingNote(true)}
            aria-label={`Add a note for ${label}`}
          >
            Add a note
          </Button>
        )}
        <QuantityStepper value={line.quantity} onChange={onQuantity} itemName={label} />
      </div>
    </li>
  );
}
