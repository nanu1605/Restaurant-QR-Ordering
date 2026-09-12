'use client';

import { cn } from 'cn';
import { ChevronRight, ReceiptText, Search, UtensilsCrossed } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/shared/empty-state';
import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatINR } from '@/lib/money';

import {
  addToCart,
  cartCount,
  cartTotalPaise,
  itemQuantity,
  lineKey,
  setLineQuantity,
  type Cart,
} from '../cart';
import { categorySectionId, filterMenu } from '../menu-filter';
import type { CustomerMenuItem, CustomerTable, CustomerVariant } from '../types';
import { CartBar } from './cart-bar';
import { OrderingUnavailable } from './ordering-unavailable';
import { QuantityStepper } from './quantity-stepper';
import { useReconciledCart } from './use-reconciled-cart';
import { VariantSheet } from './variant-sheet';

const CART_FULL = 'Your cart is full. Place this order first, then add more.';

/** Height of the sticky search + category bar; sections scroll to just below it. */
const STICKY_OFFSET_PX = 120;

type MenuViewProps = { qrToken: string; table: CustomerTable };

/** The customer menu (spec §13.1): search, Veg only, category tabs, add to cart. */
export function MenuView({ qrToken, table }: MenuViewProps) {
  const [cart, update] = useReconciledCart(qrToken, table.menu);
  const [query, setQuery] = useState('');
  const [vegOnly, setVegOnly] = useState(false);
  const [sheetItem, setSheetItem] = useState<CustomerMenuItem | null>(null);

  const categories = useMemo(
    () => filterMenu(table.menu, query, vegOnly),
    [table.menu, query, vegOnly],
  );
  const sectionIds = categories.map((c) => categorySectionId(c.id));
  const activeSection = useActiveSection(sectionIds);

  const base = `/t/${qrToken}`;
  const count = cartCount(cart);

  function change(next: Cart | null) {
    if (next) update(() => next);
    else toast(CART_FULL);
  }

  function addSimple(item: CustomerMenuItem) {
    change(
      addToCart(cart, {
        menuItemId: item.id,
        variantId: null,
        name: item.name,
        variantName: null,
        foodType: item.foodType,
        unitPricePaise: item.pricePaise,
      }),
    );
  }

  function addVariant(
    item: CustomerMenuItem,
    variant: CustomerVariant,
    quantity: number,
    note: string,
  ) {
    const next = addToCart(
      cart,
      {
        menuItemId: item.id,
        variantId: variant.id,
        name: item.name,
        variantName: variant.name,
        foodType: item.foodType,
        unitPricePaise: variant.pricePaise,
      },
      quantity,
      note,
    );
    change(next);
    if (next) setSheetItem(null);
  }

  return (
    <main className={cn('flex flex-1 flex-col', table.canOrder && count > 0 && 'pb-24')}>
      <h1 className="sr-only">Menu</h1>

      {table.sessionOrderCount !== null && (
        <Link
          href={`${base}/orders`}
          className="mx-4 mt-3 flex min-h-12 items-center justify-between gap-3 rounded-lg border border-line bg-paper px-4 text-sm font-semibold text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="flex items-center gap-2">
            <ReceiptText aria-hidden className="size-4 text-ink-muted" />
            Your table’s orders ({table.sessionOrderCount})
          </span>
          <ChevronRight aria-hidden className="size-4 text-ink-muted" />
        </Link>
      )}

      {!table.canOrder && <OrderingUnavailable className="mx-4 mt-3" />}

      {table.menu.length === 0 ? (
        <EmptyState
          icon={UtensilsCrossed}
          title="The menu isn’t ready yet"
          description="Please order with our staff."
          className="m-4"
        />
      ) : (
        <>
          <div className="sticky top-0 z-20 border-b border-line bg-surface">
            <div className="flex gap-2 px-4 pt-3 pb-2">
              <div className="relative flex-1">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search dishes"
                  aria-label="Search dishes"
                  className="h-11 pl-9 text-base"
                />
              </div>
              <button
                type="button"
                aria-pressed={vegOnly}
                onClick={() => setVegOnly((on) => !on)}
                className={cn(
                  'flex h-11 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                  vegOnly
                    ? 'border-food-veg bg-food-veg/10 text-ink'
                    : 'border-line bg-surface text-ink',
                )}
              >
                <FoodTypeMark type="veg" size="sm" />
                Veg only
              </button>
            </div>
            {categories.length > 0 && (
              <CategoryTabs
                categories={categories.map((c) => ({ id: c.id, name: c.name }))}
                activeSection={activeSection}
              />
            )}
          </div>

          {categories.length === 0 ? (
            <EmptyState
              icon={Search}
              title={
                query.trim() ? `No dishes match “${query.trim()}”` : 'No veg dishes on this menu'
              }
              description={
                vegOnly ? 'Try another word, or turn off Veg only.' : 'Try another word.'
              }
              className="m-4"
            />
          ) : (
            categories.map((category) => (
              <section
                key={category.id}
                id={categorySectionId(category.id)}
                aria-labelledby={`${categorySectionId(category.id)}-title`}
                style={{ scrollMarginTop: STICKY_OFFSET_PX }}
              >
                <h2
                  id={`${categorySectionId(category.id)}-title`}
                  className="px-4 pt-5 pb-1 text-lg font-semibold text-ink"
                >
                  {category.name}
                </h2>
                <ul className="divide-y divide-line px-4">
                  {category.items.map((item) => (
                    <MenuItemRow
                      key={item.id}
                      item={item}
                      canOrder={table.canOrder}
                      cart={cart}
                      onAdd={() =>
                        item.variants.length > 0 ? setSheetItem(item) : addSimple(item)
                      }
                      onQuantity={(quantity) =>
                        update((current) =>
                          setLineQuantity(
                            current,
                            lineKey({ menuItemId: item.id, variantId: null }),
                            quantity,
                          ),
                        )
                      }
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </>
      )}

      {table.canOrder && count > 0 && (
        <CartBar href={`${base}/cart`} count={count} totalPaise={cartTotalPaise(cart)} />
      )}
      {table.canOrder && (
        <VariantSheet item={sheetItem} onClose={() => setSheetItem(null)} onAdd={addVariant} />
      )}
    </main>
  );
}

type MenuItemRowProps = {
  item: CustomerMenuItem;
  canOrder: boolean;
  cart: Cart;
  onAdd: () => void;
  onQuantity: (quantity: number) => void;
};

function MenuItemRow({ item, canOrder, cart, onAdd, onQuantity }: MenuItemRowProps) {
  const hasOptions = item.variants.length > 0;
  const inCart = itemQuantity(cart, item.id);
  const price = formatINR(item.pricePaise, { fraction: 'auto' });

  return (
    <li className="flex gap-3 py-4" data-available={item.isAvailable}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-2">
          <FoodTypeMark type={item.foodType} size="sm" className="mt-1" />
          <h3
            className={cn(
              'text-base font-semibold',
              item.isAvailable ? 'text-ink' : 'text-ink-muted',
            )}
          >
            {item.name}
          </h3>
        </div>
        <p className="text-sm font-medium text-ink tabular-nums">
          {hasOptions ? `from ${price}` : price}
        </p>
        {item.description && (
          <p className="line-clamp-2 text-sm text-ink-muted">{item.description}</p>
        )}
      </div>

      <div className="flex w-32 shrink-0 flex-col items-center gap-2">
        {item.imageUrl && (
          <Image
            src={item.imageUrl}
            alt=""
            width={112}
            height={112}
            sizes="112px"
            className={cn(
              'size-28 rounded-lg bg-paper object-cover',
              !item.isAvailable && 'opacity-60 grayscale',
            )}
          />
        )}
        {!item.isAvailable ? (
          <p className="text-sm font-semibold text-ink-muted">Not available</p>
        ) : !canOrder ? null : hasOptions || inCart === 0 ? (
          <>
            <Button
              size="touch"
              className="w-full"
              onClick={onAdd}
              aria-label={`Add ${item.name}`}
              aria-haspopup={hasOptions ? 'dialog' : undefined}
            >
              Add
            </Button>
            {hasOptions && inCart > 0 && (
              <p className="text-xs font-medium text-ink-muted tabular-nums">{inCart} in cart</p>
            )}
          </>
        ) : (
          <QuantityStepper value={inCart} onChange={onQuantity} itemName={item.name} />
        )}
      </div>
    </li>
  );
}

function CategoryTabs({
  categories,
  activeSection,
}: {
  categories: { id: string; name: string }[];
  activeSection: string | null;
}) {
  const navRef = useRef<HTMLElement>(null);
  const current =
    categories.find((c) => categorySectionId(c.id) === activeSection)?.id ?? categories[0]?.id;

  // Keep the highlighted tab in view as the menu scrolls.
  useEffect(() => {
    const nav = navRef.current;
    const tab = nav?.querySelector<HTMLElement>(`[data-category="${current}"]`);
    if (!nav || !tab) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    nav.scrollTo({
      left: tab.offsetLeft - (nav.clientWidth - tab.clientWidth) / 2,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, [current]);

  return (
    <nav
      ref={navRef}
      aria-label="Menu categories"
      className="relative flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 pb-2"
    >
      {categories.map((category) => {
        const active = category.id === current;
        return (
          <a
            key={category.id}
            href={`#${categorySectionId(category.id)}`}
            data-category={category.id}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'flex h-9 shrink-0 items-center rounded-full border px-3 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
              active
                ? 'border-transparent bg-primary text-primary-foreground'
                : 'border-line bg-surface text-ink',
            )}
          >
            {category.name}
          </a>
        );
      })}
    </nav>
  );
}

/** Scroll-spy: the first category section showing below the sticky bar. */
function useActiveSection(sectionIds: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = sectionIds.join(' ');

  useEffect(() => {
    const ids = key ? key.split(' ') : [];
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((section): section is HTMLElement => section !== null);
    if (sections.length === 0) return;

    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
        const first = ids.find((id) => visible.get(id));
        if (first) setActive(first);
      },
      { rootMargin: `-${STICKY_OFFSET_PX}px 0px -55% 0px` },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [key]);

  return active;
}
