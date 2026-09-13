'use client';

import { cn } from 'cn';
import { ChevronRight, ReceiptText, Search, UtensilsCrossed } from 'lucide-react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
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
import { categorySectionId, countItems, filterMenu } from '../menu-filter';
import type { CustomerCategory, CustomerMenuItem, CustomerTable, CustomerVariant } from '../types';
import { CartBar } from './cart-bar';
import { OrderingUnavailable } from './ordering-unavailable';
import { QuantityStepper } from './quantity-stepper';
import { useReconciledCart } from './use-reconciled-cart';

// The options sheet (Base UI dialog + radio group) is the heaviest part of the
// menu's JavaScript and only needed on a tap, so it loads after the page.
const VariantSheet = dynamic(() => import('./variant-sheet').then((m) => m.VariantSheet), {
  ssr: false,
});

const CART_FULL = 'Your cart is full. Place this order first, then add more.';

/** Height of the sticky search + category bar (content scrolls to just below it). */
const STICKY_OFFSET_PX = 124;

// Keeps focused controls and category jumps clear of the sticky search bar
// and the fixed cart bar.
const SCROLL_PADDING = `html{scroll-padding-top:${STICKY_OFFSET_PX}px;scroll-padding-bottom:6rem}`;

type MenuViewProps = { qrToken: string; table: CustomerTable };

/** The customer menu (spec §13.1): search, Veg only, category tabs, add to cart. */
export function MenuView({ qrToken, table }: MenuViewProps) {
  const [cart, update] = useReconciledCart(qrToken, table.menu);
  const [query, setQuery] = useState('');
  const [vegOnly, setVegOnly] = useState(false);
  const [sheetItem, setSheetItem] = useState<CustomerMenuItem | null>(null);
  // Screen readers hear what changed: dishes added, search results (WCAG 4.1.3).
  const [announcement, setAnnouncement] = useState('');

  const categories = useMemo(
    () => filterMenu(table.menu, query, vegOnly),
    [table.menu, query, vegOnly],
  );
  const [activeSection, selectSection] = useActiveSection(
    categories.map((c) => categorySectionId(c.id)),
  );
  const hasOptionDishes = table.menu.some((c) => c.items.some((i) => i.variants.length > 0));

  const base = `/t/${qrToken}`;
  const count = cartCount(cart);

  function announceResults(nextQuery: string, nextVegOnly: boolean) {
    if (!nextQuery.trim() && !nextVegOnly) {
      setAnnouncement('');
      return;
    }
    const found = countItems(filterMenu(table.menu, nextQuery, nextVegOnly));
    setAnnouncement(
      found === 0 ? 'No dishes found.' : `${found} ${found === 1 ? 'dish' : 'dishes'} found.`,
    );
  }

  function addSimple(item: CustomerMenuItem) {
    const next = addToCart(cart, {
      menuItemId: item.id,
      variantId: null,
      name: item.name,
      variantName: null,
      foodType: item.foodType,
      unitPricePaise: item.pricePaise,
    });
    if (!next) {
      toast(CART_FULL);
      return;
    }
    update(() => next);
    setAnnouncement(`${item.name} added. ${itemQuantity(next, item.id)} in cart.`);
  }

  function changeQuantity(item: CustomerMenuItem, quantity: number) {
    const next = setLineQuantity(cart, lineKey({ menuItemId: item.id, variantId: null }), quantity);
    update(() => next);
    const left = itemQuantity(next, item.id);
    setAnnouncement(
      left === 0 ? `${item.name} removed from cart.` : `${left} ${item.name} in cart.`,
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
    if (!next) {
      toast(CART_FULL);
      return;
    }
    update(() => next);
    setSheetItem(null);
    setAnnouncement(
      `${item.name} (${variant.name}) added. ${itemQuantity(next, item.id)} in cart.`,
    );
  }

  return (
    <main className={cn('flex flex-1 flex-col', table.canOrder && count > 0 && 'pb-24')}>
      <style>{SCROLL_PADDING}</style>
      <h1 className="sr-only">Menu</h1>
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {table.sessionOrderCount !== null && (
        <Link
          href={`${base}/orders`}
          className="mx-4 mt-3 flex min-h-12 items-center justify-between gap-3 rounded-lg border border-line bg-paper px-4 text-sm font-semibold text-ink"
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
                  onChange={(event) => {
                    setQuery(event.target.value);
                    announceResults(event.target.value, vegOnly);
                  }}
                  placeholder="Search dishes"
                  aria-label="Search dishes"
                  className="h-11 pl-9 text-base"
                />
              </div>
              <button
                type="button"
                aria-pressed={vegOnly}
                onClick={() => {
                  setVegOnly(!vegOnly);
                  announceResults(query, !vegOnly);
                }}
                className={cn(
                  'flex h-11 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-semibold text-ink',
                  vegOnly ? 'border-food-veg bg-food-veg/10' : 'border-line bg-surface',
                )}
              >
                <FoodTypeMark type="veg" size="sm" />
                Veg only
              </button>
            </div>
            {categories.length > 0 && (
              <CategoryTabs
                categories={categories}
                activeSection={activeSection}
                onSelect={selectSection}
              />
            )}
          </div>

          {categories.length === 0 ? (
            <NoResults query={query.trim()} vegOnly={vegOnly} />
          ) : (
            categories.map((category) => (
              <section
                key={category.id}
                id={categorySectionId(category.id)}
                aria-labelledby={`${categorySectionId(category.id)}-title`}
              >
                <h2
                  id={`${categorySectionId(category.id)}-title`}
                  tabIndex={-1}
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
                      onQuantity={(quantity) => changeQuantity(item, quantity)}
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
      {table.canOrder && hasOptionDishes && (
        <VariantSheet item={sheetItem} onClose={() => setSheetItem(null)} onAdd={addVariant} />
      )}
    </main>
  );
}

function NoResults({ query, vegOnly }: { query: string; vegOnly: boolean }) {
  return (
    <EmptyState
      icon={Search}
      title={query ? `No dishes match “${query}”` : 'No veg dishes on this menu'}
      description={
        !query
          ? 'Turn off Veg only to see all dishes.'
          : vegOnly
            ? 'Try another word, or turn off Veg only.'
            : 'Try another word.'
      }
      className="m-4"
    />
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
  const showStepper = !hasOptions && inCart > 0;

  // Add and the stepper replace each other; keep focus on the control that
  // took the place of the one just used (WCAG 2.4.3).
  const addRef = useRef<HTMLButtonElement>(null);
  const incrementRef = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef<'stepper' | 'add' | null>(null);
  useEffect(() => {
    if (moveFocus.current === 'stepper' && showStepper) incrementRef.current?.focus();
    if (moveFocus.current === 'add' && !showStepper) addRef.current?.focus();
    moveFocus.current = null;
  }, [showStepper]);

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
        ) : !canOrder ? null : showStepper ? (
          <QuantityStepper
            value={inCart}
            onChange={(quantity) => {
              if (quantity === 0) moveFocus.current = 'add';
              onQuantity(quantity);
            }}
            itemName={item.name}
            incrementRef={incrementRef}
          />
        ) : (
          <>
            <Button
              ref={addRef}
              size="touch"
              className="w-full"
              onClick={() => {
                if (!hasOptions) moveFocus.current = 'stepper';
                onAdd();
              }}
              aria-label={`Add ${item.name}`}
              aria-haspopup={hasOptions ? 'dialog' : undefined}
            >
              Add
            </Button>
            {hasOptions && inCart > 0 && (
              <p className="text-xs font-medium text-ink-muted tabular-nums">{inCart} in cart</p>
            )}
          </>
        )}
      </div>
    </li>
  );
}

type CategoryTabsProps = {
  categories: CustomerCategory[];
  activeSection: string | null;
  onSelect: (sectionId: string) => void;
};

function CategoryTabs({ categories, activeSection, onSelect }: CategoryTabsProps) {
  const navRef = useRef<HTMLElement>(null);
  const current =
    categories.find((c) => categorySectionId(c.id) === activeSection)?.id ?? categories[0]?.id;

  // Keep the highlighted tab in view as the menu scrolls.
  useEffect(() => {
    const nav = navRef.current;
    const tab = nav?.querySelector<HTMLElement>(`[data-category="${current}"]`);
    if (!nav || !tab) return;
    nav.scrollTo({
      left: tab.offsetLeft - (nav.clientWidth - tab.clientWidth) / 2,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [current]);

  // Scroll without a URL fragment: a native #fragment jump adds a history entry
  // the Next.js router ignores, which breaks the phone's Back button.
  function jump(event: MouseEvent<HTMLAnchorElement>, sectionId: string) {
    event.preventDefault();
    onSelect(sectionId);
    const section = document.getElementById(sectionId);
    section?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    // Screen readers continue from the category heading.
    document.getElementById(`${sectionId}-title`)?.focus({ preventScroll: true });
  }

  return (
    <nav
      ref={navRef}
      aria-label="Menu categories"
      className="relative flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 pb-2"
    >
      {categories.map((category) => {
        const active = category.id === current;
        const sectionId = categorySectionId(category.id);
        return (
          <a
            key={category.id}
            href={`#${sectionId}`}
            onClick={(event) => jump(event, sectionId)}
            data-category={category.id}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'flex h-11 shrink-0 items-center rounded-full border px-4 text-sm font-medium whitespace-nowrap',
              // The ring colour keeps the current tab visible even on a light accent.
              active
                ? 'border-ring bg-primary font-semibold text-primary-foreground'
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

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Scroll-spy: the last category whose heading has scrolled up to the sticky
 * bar, or the last category once the page is at its end. A tapped tab stays
 * selected until the customer scrolls themselves.
 */
function useActiveSection(sectionIds: string[]): [string | null, (sectionId: string) => void] {
  const [active, setActive] = useState<string | null>(null);
  const tapped = useRef<string | null>(null);
  const key = sectionIds.join(' ');

  useEffect(() => {
    const ids = key ? key.split(' ') : [];
    if (ids.length === 0) return;
    let frame = 0;

    const measure = () => {
      frame = 0;
      if (tapped.current) {
        setActive(tapped.current);
        return;
      }
      const root = document.documentElement;
      let current = ids[0]!;
      if (window.innerHeight + window.scrollY >= root.scrollHeight - 2) {
        current = ids[ids.length - 1]!;
      } else {
        for (const id of ids) {
          const top = document.getElementById(id)?.getBoundingClientRect().top;
          if (top === undefined || top > STICKY_OFFSET_PX + 1) break;
          current = id;
        }
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    // The customer scrolling on their own releases a tapped tab.
    const release = () => {
      tapped.current = null;
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    window.addEventListener('wheel', release, { passive: true });
    window.addEventListener('touchstart', release, { passive: true });
    window.addEventListener('keydown', release);
    onScroll();
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('wheel', release);
      window.removeEventListener('touchstart', release);
      window.removeEventListener('keydown', release);
    };
  }, [key]);

  function select(sectionId: string) {
    tapped.current = sectionId;
    setActive(sectionId);
  }

  return [active, select];
}
