'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, XIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useLive } from '@/features/live/live-provider';
import { BOARD_MUTATION_KEY, menuKey } from '@/features/live/query-client';
import {
  addToCart,
  cartCount,
  cartLineFor,
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
  type Cart,
  type NewCartLine,
} from '@/features/ordering/cart';
import { OptionsSheet } from '@/features/ordering/components/options-sheet';
import { QuantityStepper } from '@/features/ordering/components/quantity-stepper';
import { MAX_LINE_NOTE, MAX_ORDER_NOTE } from '@/features/ordering/limits';
import { filterMenu } from '@/features/ordering/menu-filter';
import type { CustomerMenuItem } from '@/features/ordering/types';
import { formatINR } from '@/lib/money';
import { createClient } from '@/lib/supabase/browser';

import { placeStaffOrder, type StaffOrderResult } from '../actions';
import { rememberOwnOrder } from '../alert-store';
import type { Board, BoardTable } from '../board';
import type { StaffOrderInput } from '../schemas';
import { useStaffLang, useStaffStrings } from '../staff-lang';
import { fetchStaffMenu } from '../staff-menu';

type AddDishesSheetProps = {
  board: Board;
  /** Open while set; a free table gets "Add order", which opens a session. */
  table: BoardTable | null;
  onClose: () => void;
};

/**
 * "Add dishes" / "Add order" (spec §13.2, §10.8): a compact menu picker that
 * places a new round with staff_place_order — never edits earlier rounds.
 */
export function AddDishesSheet({ board, table, onClose }: AddDishesSheetProps) {
  const t = useStaffStrings();
  return (
    <Sheet open={table !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 sm:max-w-xl">
        {table && <Picker key={table.id} board={board} table={table} onDone={onClose} />}
        <SheetClose
          render={<Button variant="ghost" size="icon-touch" className="absolute top-2 right-2" />}
        >
          <XIcon aria-hidden />
          <span className="sr-only">{t.close}</span>
        </SheetClose>
      </SheetContent>
    </Sheet>
  );
}

const price = (paise: number) => formatINR(paise, { fraction: 'auto' });

function Picker({ board, table, onDone }: { board: Board; table: BoardTable; onDone: () => void }) {
  const ids = useId();
  const queryClient = useQueryClient();
  const { restaurantId } = useLive();
  const t = useStaffStrings();
  const lang = useStaffLang();
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [search, setSearch] = useState('');
  // Made when the picker opens, kept across retries, so a retry never doubles the round.
  const [idempotencyKey, setIdempotencyKey] = useState(randomUuid);
  const [sessionAtOpen] = useState(table.session?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [sheetItem, setSheetItem] = useState<CustomerMenuItem | null>(null);

  const menu = useQuery({
    // By language too: the names differ, and /admin/live shares the cache.
    queryKey: [...menuKey(restaurantId), lang],
    queryFn: () => fetchStaffMenu(createClient(), lang),
    staleTime: 60_000,
  });

  const place = useMutation({
    mutationKey: BOARD_MUTATION_KEY,
    mutationFn: (input: StaffOrderInput): Promise<StaffOrderResult> => placeStaffOrder(input),
    // A refetch already on its way could bring the new round back before this
    // device knows it placed it, and chime for its own order.
    onMutate: () => queryClient.cancelQueries({ queryKey: ['board'] }),
    onSuccess: (result) => {
      // Before the board refetches, so this device doesn't chime for its own order.
      if (result.ok) rememberOwnOrder(result.data.orderId);
    },
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: BOARD_MUTATION_KEY }) === 1) {
        void queryClient.invalidateQueries({ queryKey: ['board'] });
      }
    },
  });

  const heading = t.table(table.label);
  const hasSession = table.session !== null;
  const count = cartCount(cart);
  const sessionChanged = (table.session?.id ?? null) !== sessionAtOpen;
  const shown = filterMenu(menu.data ?? [], search, false);

  function add(line: NewCartLine, quantity = 1, note = '') {
    setSheetItem(null);
    const next = addToCart(cart, line, quantity, note);
    if (!next) {
      setError(t.add.tooMany);
      return;
    }
    setError(null);
    setCart(next);
  }

  async function submit() {
    setError(null);
    let result: StaffOrderResult;
    try {
      result = await place.mutateAsync({
        tableId: table.id,
        idempotencyKey,
        lines: toOrderLines(cart),
        note: cart.note.trim() || null,
      });
    } catch {
      setError(t.network);
      return;
    }
    if (!result.ok) {
      if (result.unavailableLines?.length) {
        const { cart: next, removed } = removeLines(
          cart,
          refusedKeys(cart.lines, result.unavailableLines),
        );
        setCart(next);
        setError(t.add.unavailable(removed));
        void queryClient.invalidateQueries({ queryKey: menuKey(restaurantId) });
      } else {
        setError(t.refusal(result));
      }
      return;
    }

    const { roundNumber, assignedWaiterId } = result.data;
    const nowMine =
      assignedWaiterId !== null &&
      assignedWaiterId === board.myWaiterId &&
      !table.session?.assignedWaiterId;
    toast.success(
      roundNumber === 1 ? t.add.placedFirst(heading) : t.add.placedRound(roundNumber, heading),
      { description: nowMine ? t.add.nowYours : undefined },
    );
    setCart(EMPTY_CART);
    setIdempotencyKey(randomUuid());
    onDone();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader className="gap-2 border-b border-line pr-14">
        <SheetTitle className="text-xl font-bold text-ink">
          {hasSession ? t.drawer.addDishes : t.drawer.addOrder} · {heading}
        </SheetTitle>
        <SheetDescription className="text-sm text-ink-muted">
          {hasSession ? t.add.toSession : t.add.toNewSession}
        </SheetDescription>
        {sessionChanged && (
          <p
            role="status"
            className="rounded-md border border-attention px-3 py-2 text-sm text-ink"
          >
            {t.add.changed(heading, sessionAtOpen !== null)}
          </p>
        )}
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
          />
          <Input
            type="search"
            aria-label={t.add.search}
            placeholder={t.add.search}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-11 pl-9 text-base"
          />
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {menu.isPending ? (
          <div role="status" className="flex flex-col gap-2">
            <span className="sr-only">{t.add.loadingMenu}</span>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : menu.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2 text-sm text-ink">
            {t.add.menuFailed}
            <Button variant="outline" size="touch" onClick={() => void menu.refetch()}>
              {t.tryAgain}
            </Button>
          </div>
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-muted">
            {search ? t.add.noMatch(search.trim()) : t.add.emptyMenu}
          </p>
        ) : (
          shown.map((category) => (
            <section key={category.id} aria-labelledby={`${ids}-${category.id}`} className="mb-4">
              <h3
                id={`${ids}-${category.id}`}
                className="mb-1 text-sm font-semibold tracking-wide text-ink-muted"
              >
                {category.name}
              </h3>
              <ul className="flex flex-col">
                {category.items.map((item) => (
                  <MenuRow
                    key={item.id}
                    item={item}
                    cart={cart}
                    onAdd={add}
                    onChoose={() => setSheetItem(item)}
                    onSetCart={setCart}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <div className="flex max-h-[45dvh] flex-col gap-3 overflow-y-auto border-t border-line bg-surface p-4">
        {cart.lines.length > 0 && (
          <ul aria-label={t.add.thisRound} className="flex flex-col gap-2">
            {cart.lines.map((line) => {
              const key = lineKey(line);
              const name = lineLabel(line);
              return (
                <li key={key} className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 text-base text-ink">
                      <FoodTypeMark
                        type={line.foodType}
                        size="sm"
                        label={t.foodType[line.foodType]}
                      />
                      <span className="min-w-0 break-words">{name}</span>
                    </span>
                    <QuantityStepper
                      value={line.quantity}
                      onChange={(quantity) => setCart(setLineQuantity(cart, key, quantity))}
                      itemName={name}
                    />
                  </div>
                  <Input
                    aria-label={t.add.noteFor(name)}
                    placeholder={t.add.notePlaceholder}
                    value={line.note}
                    maxLength={MAX_LINE_NOTE}
                    onChange={(event) => setCart(setLineNote(cart, key, event.target.value))}
                    className="h-11 text-sm"
                  />
                </li>
              );
            })}
          </ul>
        )}
        {cart.lines.length > 0 && (
          <Textarea
            aria-label={t.add.roundNote}
            placeholder={t.add.roundNotePlaceholder}
            value={cart.note}
            maxLength={MAX_ORDER_NOTE}
            onChange={(event) => setCart(setOrderNote(cart, event.target.value))}
            rows={1}
            className="text-sm"
          />
        )}

        {error && (
          <p role="alert" className="text-sm font-medium text-status-void">
            {error}
          </p>
        )}
        {!board.canOrder && <p className="text-sm text-ink-muted">{t.drawer.paused}</p>}

        <div className="flex items-center justify-between gap-3">
          <span aria-live="polite" className="text-base font-semibold text-ink tabular-nums">
            {count === 0
              ? t.add.noDishes
              : `${t.add.items(count)} · ${price(cartTotalPaise(cart))}`}
          </span>
          <Button
            size="touch"
            onClick={() => void submit()}
            disabled={count === 0 || place.isPending || !board.canOrder}
          >
            {place.isPending ? t.add.placing : t.add.place}
          </Button>
        </div>
      </div>
      <OptionsSheet
        item={sheetItem}
        onClose={() => setSheetItem(null)}
        onAdd={add}
        addLabel={t.add.addToRound}
      />
    </div>
  );
}

type MenuRowProps = {
  item: CustomerMenuItem;
  cart: Cart;
  onAdd: (line: NewCartLine) => void;
  /** Dishes with add-ons are chosen in the options sheet. */
  onChoose: () => void;
  onSetCart: (cart: Cart) => void;
};

function MenuRow({ item, cart, onAdd, onChoose, onSetCart }: MenuRowProps) {
  const t = useStaffStrings();
  const simpleKey = lineKey({ menuItemId: item.id, variantId: null });
  const simpleLine = cart.lines.find((line) => lineKey(line) === simpleKey);

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-b-0">
      <span className="flex min-w-0 items-center gap-2">
        <FoodTypeMark type={item.foodType} size="sm" label={t.foodType[item.foodType]} />
        <span className={item.isAvailable ? 'text-base text-ink' : 'text-base text-ink-muted'}>
          {item.name}
        </span>
        {item.variants.length === 0 && (
          <span className="text-sm text-ink-muted tabular-nums">{price(item.pricePaise)}</span>
        )}
      </span>

      {!item.isAvailable ? (
        <span className="text-sm font-medium text-ink-muted">{t.add.outOfStock}</span>
      ) : item.addonGroups.length > 0 ? (
        <Button variant="outline" size="touch" aria-haspopup="dialog" onClick={onChoose}>
          {t.add.choose}
          <span className="sr-only"> {item.name}</span>
        </Button>
      ) : item.variants.length > 0 ? (
        <span className="flex flex-wrap gap-2">
          {item.variants.map((variant) => (
            <Button
              key={variant.id}
              variant="outline"
              size="touch"
              onClick={() => onAdd(cartLineFor(item, variant.id))}
            >
              {/* The name starts with the visible text (WCAG 2.5.3). */}
              {variant.name} · <span className="tabular-nums">{price(variant.pricePaise)}</span>
              <span className="sr-only">{t.add.addName(item.name)}</span>
            </Button>
          ))}
        </span>
      ) : simpleLine ? (
        <QuantityStepper
          value={simpleLine.quantity}
          onChange={(quantity) => onSetCart(setLineQuantity(cart, simpleKey, quantity))}
          itemName={item.name}
        />
      ) : (
        <Button variant="outline" size="touch" onClick={() => onAdd(cartLineFor(item, null))}>
          {t.add.add}
          <span className="sr-only"> {item.name}</span>
        </Button>
      )}
    </li>
  );
}
