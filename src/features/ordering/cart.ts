'use client';

import { useCallback, useSyncExternalStore } from 'react';

import type { FoodType } from '@/components/shared/food-type-mark';

import { chosenAddons, lineFits } from './addons';
import { dishName } from './format';
import {
  IDEMPOTENCY_KEY_PATTERN,
  MAX_LINE_NOTE,
  MAX_LINE_QUANTITY,
  MAX_ORDER_LINES,
  MAX_ORDER_NOTE,
} from './limits';
import type { CustomerCategory, CustomerMenuItem } from './types';

/**
 * The customer's cart (spec §13.1), kept in localStorage per QR token so a
 * refresh doesn't lose it. One line per dish (or dish + option). Names and
 * prices here are only for display: the database snapshots its own when the
 * order is placed.
 */

export type CartLine = {
  menuItemId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  /** Chosen add-ons, sorted; left out when there are none (and in carts saved before add-ons). */
  addonIds?: string[];
  addonNames?: string[];
  foodType: FoodType;
  /** Option (or dish) price plus the add-ons. */
  unitPricePaise: number;
  quantity: number;
  note: string;
};

export type Cart = { lines: CartLine[]; note: string };

export const EMPTY_CART: Cart = { lines: [], note: '' };

export type NewCartLine = Omit<CartLine, 'quantity' | 'note'>;

export function lineKey(line: {
  menuItemId: string;
  variantId: string | null;
  addonIds?: readonly string[];
}): string {
  const key = `${line.menuItemId}:${line.variantId ?? ''}`;
  return line.addonIds?.length ? `${key}:${line.addonIds.join(',')}` : key;
}

/** A cart line for the dish with this option and add-ons, priced from the menu. */
export function cartLineFor(
  item: CustomerMenuItem,
  variantId: string | null,
  addonIds: readonly string[] = [],
): NewCartLine {
  const variant = item.variants.find((v) => v.id === variantId);
  const addons = chosenAddons(item.addonGroups, addonIds);
  return {
    menuItemId: item.id,
    variantId: variant?.id ?? null,
    name: item.name,
    variantName: variant?.name ?? null,
    ...(addons.length > 0
      ? { addonIds: addons.map((a) => a.id).sort(), addonNames: addons.map((a) => a.name) }
      : {}),
    foodType: item.foodType,
    unitPricePaise:
      (variant?.pricePaise ?? item.pricePaise) + addons.reduce((sum, a) => sum + a.pricePaise, 0),
  };
}

const clampQuantity = (quantity: number) =>
  Math.min(MAX_LINE_QUANTITY, Math.max(0, Math.trunc(quantity)));

/** Adds dishes; returns null when a new line would exceed 30 lines. */
export function addToCart(cart: Cart, line: NewCartLine, quantity = 1, note = ''): Cart | null {
  const key = lineKey(line);
  const existing = cart.lines.find((l) => lineKey(l) === key);
  if (existing) {
    return {
      ...cart,
      lines: cart.lines.map((l) =>
        l === existing
          ? {
              ...l,
              quantity: clampQuantity(l.quantity + quantity),
              note: note.trim() ? note.trim().slice(0, MAX_LINE_NOTE) : l.note,
            }
          : l,
      ),
    };
  }
  if (cart.lines.length >= MAX_ORDER_LINES) return null;
  return {
    ...cart,
    lines: [
      ...cart.lines,
      {
        ...line,
        quantity: Math.max(1, clampQuantity(quantity)),
        note: note.trim().slice(0, MAX_LINE_NOTE),
      },
    ],
  };
}

/** Sets a line's quantity; 0 removes it. */
export function setLineQuantity(cart: Cart, key: string, quantity: number): Cart {
  const next = clampQuantity(quantity);
  return {
    ...cart,
    lines:
      next === 0
        ? cart.lines.filter((l) => lineKey(l) !== key)
        : cart.lines.map((l) => (lineKey(l) === key ? { ...l, quantity: next } : l)),
  };
}

export function setLineNote(cart: Cart, key: string, note: string): Cart {
  return {
    ...cart,
    lines: cart.lines.map((l) =>
      lineKey(l) === key ? { ...l, note: note.slice(0, MAX_LINE_NOTE) } : l,
    ),
  };
}

export function setOrderNote(cart: Cart, note: string): Cart {
  return { ...cart, note: note.slice(0, MAX_ORDER_NOTE) };
}

export function cartCount(cart: Cart): number {
  return cart.lines.reduce((sum, l) => sum + l.quantity, 0);
}

export function cartTotalPaise(cart: Cart): number {
  return cart.lines.reduce((sum, l) => sum + l.unitPricePaise * l.quantity, 0);
}

/** How many of a dish are in the cart, across its options. */
export function itemQuantity(cart: Cart, menuItemId: string): number {
  return cart.lines
    .filter((l) => l.menuItemId === menuItemId)
    .reduce((sum, l) => sum + l.quantity, 0);
}

export type CartUpdate = { cart: Cart; removed: string[] };

export function lineLabel(line: CartLine): string {
  return dishName({ name: line.name, variant: line.variantName, addons: line.addonNames });
}

/**
 * Brings the cart in line with the current menu: dishes that are gone, out of
 * stock, or whose option or add-ons no longer fit are dropped (and named), and
 * names and prices are refreshed.
 */
export function reconcileCart(cart: Cart, menu: CustomerCategory[]): CartUpdate {
  const items = new Map<string, CustomerMenuItem>();
  for (const category of menu) for (const item of category.items) items.set(item.id, item);

  const removed: string[] = [];
  const lines: CartLine[] = [];
  for (const line of cart.lines) {
    const item = items.get(line.menuItemId);
    if (!item || !lineFits(item, line.variantId, line.addonIds)) {
      removed.push(lineLabel(line));
      continue;
    }
    lines.push({
      quantity: line.quantity,
      note: line.note,
      ...cartLineFor(item, line.variantId, line.addonIds),
    });
  }
  return { cart: { ...cart, lines }, removed };
}

/** Drops the lines the database refused (by lineKey) and names them. */
export function removeLines(cart: Cart, keys: string[]): CartUpdate {
  const drop = new Set(keys);
  return {
    cart: { ...cart, lines: cart.lines.filter((l) => !drop.has(lineKey(l))) },
    removed: cart.lines.filter((l) => drop.has(lineKey(l))).map(lineLabel),
  };
}

/** The keys of the submitted lines the server refused (indexes into what was sent). */
export function refusedKeys(submitted: CartLine[], indexes: number[]): string[] {
  return indexes.flatMap((index) => (submitted[index] ? [lineKey(submitted[index])] : []));
}

/** The order lines customer_place_order expects. */
export function toOrderLines(cart: Cart) {
  return cart.lines.map((l) => ({
    menuItemId: l.menuItemId,
    variantId: l.variantId,
    quantity: l.quantity,
    note: l.note.trim() || null,
    ...(l.addonIds?.length ? { addonIds: l.addonIds } : {}),
  }));
}

// ─── Stored cart ────────────────────────────────────────────────────────────

const FOOD_TYPES: readonly string[] = ['veg', 'non_veg', 'egg'];

const isStringList = (value: unknown) =>
  value === undefined ||
  (Array.isArray(value) && value.length <= 20 && value.every((v) => typeof v === 'string'));

function isCartLine(value: unknown): value is CartLine {
  if (typeof value !== 'object' || value === null) return false;
  const l = value as Record<string, unknown>;
  return (
    typeof l.menuItemId === 'string' &&
    (l.variantId === null || typeof l.variantId === 'string') &&
    typeof l.name === 'string' &&
    (l.variantName === null || typeof l.variantName === 'string') &&
    isStringList(l.addonIds) &&
    isStringList(l.addonNames) &&
    typeof l.foodType === 'string' &&
    FOOD_TYPES.includes(l.foodType) &&
    Number.isInteger(l.unitPricePaise) &&
    Number.isInteger(l.quantity) &&
    (l.quantity as number) >= 1 &&
    (l.quantity as number) <= MAX_LINE_QUANTITY &&
    typeof l.note === 'string'
  );
}

/** Reads a stored cart, ignoring anything that isn't one (old versions, tampering). */
export function parseStoredCart(raw: string | null): Cart {
  if (!raw) return EMPTY_CART;
  try {
    const value = JSON.parse(raw) as { v?: unknown; lines?: unknown; note?: unknown };
    if (value.v !== 1 || !Array.isArray(value.lines)) return EMPTY_CART;
    return {
      lines: value.lines.filter(isCartLine).slice(0, MAX_ORDER_LINES),
      note: typeof value.note === 'string' ? value.note.slice(0, MAX_ORDER_NOTE) : '',
    };
  } catch {
    return EMPTY_CART;
  }
}

export function serializeCart(cart: Cart): string {
  return JSON.stringify({ v: 1, lines: cart.lines, note: cart.note });
}

const storageKey = (qrToken: string) => `tableorder:cart:${qrToken}`;

const listeners = new Set<() => void>();
// Parsed carts by token, reused while the stored string is unchanged so
// useSyncExternalStore sees a stable snapshot. Also the fallback when storage
// is unavailable (private mode, blocked site data).
const snapshots = new Map<string, { raw: string | null; cart: Cart }>();

function readRaw(qrToken: string): string | null | undefined {
  try {
    return window.localStorage.getItem(storageKey(qrToken));
  } catch {
    return undefined;
  }
}

function getCart(qrToken: string): Cart {
  const raw = readRaw(qrToken);
  const cached = snapshots.get(qrToken);
  if (raw === undefined) return cached?.cart ?? EMPTY_CART;
  if (cached && cached.raw === raw) return cached.cart;
  const cart = parseStoredCart(raw);
  snapshots.set(qrToken, { raw, cart });
  return cart;
}

export function updateCart(qrToken: string, update: (cart: Cart) => Cart): void {
  const next = update(getCart(qrToken));
  const raw = next.lines.length === 0 && !next.note ? null : serializeCart(next);
  try {
    if (raw === null) window.localStorage.removeItem(storageKey(qrToken));
    else window.localStorage.setItem(storageKey(qrToken), raw);
  } catch {
    // Storage unavailable: the in-memory snapshot below still works for this visit.
  }
  snapshots.set(qrToken, { raw: readRaw(qrToken) ?? raw, cart: next });
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab of the same table changed the cart.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** The cart for this table, updated live; empty during server rendering. */
export function useCart(qrToken: string) {
  const cart = useSyncExternalStore(
    subscribe,
    () => getCart(qrToken),
    () => EMPTY_CART,
  );
  const update = useCallback((fn: (cart: Cart) => Cart) => updateCart(qrToken, fn), [qrToken]);
  return [cart, update] as const;
}

/**
 * A random v4 uuid for idempotency keys. crypto.randomUUID only exists in
 * secure contexts, and phones on a local network test over plain http.
 */
export function randomUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── Order key ──────────────────────────────────────────────────────────────

/**
 * How long a key is kept for a resend of its order: a deploy and a retry. Any longer and a second
 * round of the same dishes, later in the meal, would get the first order back from the server's
 * dedupe on the key, and place nothing.
 */
export const ORDER_KEY_TTL_MS = 10 * 60_000;

/** The key an order was last sent with, what it held, and when. */
type SentOrder = { key: string; sent: string; at: number };

const orderKeyStorageKey = (qrToken: string) => `tableorder:order-key:${qrToken}`;

/** What an order holds, to tell a resend from a new one: the lines the server gets, and the note. */
const orderFingerprint = (cart: Cart) =>
  JSON.stringify({ lines: toOrderLines(cart), note: cart.note });

function readSentOrder(qrToken: string): SentOrder | null {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(orderKeyStorageKey(qrToken)) ?? 'null',
    );
    if (typeof value !== 'object' || value === null) return null;
    const { key, sent, at } = value as Record<string, unknown>;
    return typeof key === 'string' &&
      IDEMPOTENCY_KEY_PATTERN.test(key) &&
      typeof sent === 'string' &&
      typeof at === 'number' &&
      Number.isFinite(at)
      ? { key, sent, at }
      : null;
  } catch {
    return null;
  }
}

/**
 * The key to place this cart's order with, kept for a resend (spec §9.3). A resend of the same
 * order, its lines and note, within ORDER_KEY_TTL_MS of the last send, gets the key it was sent
 * with, also after the page reloaded, so the server answers with the order it has instead of
 * creating a second one: the refresh onto a new build is such a reload (docs/DECISIONS.md VPS-8).
 * Any other order gets `own`, the page's key; so does blocked storage.
 */
export function orderKeyToSend(qrToken: string, cart: Cart, own: string, now = Date.now()): string {
  const sent = orderFingerprint(cart);
  const last = readSentOrder(qrToken);
  const resend = last !== null && last.sent === sent && now - last.at < ORDER_KEY_TTL_MS;
  const key = resend ? last.key : own;
  try {
    window.localStorage.setItem(
      orderKeyStorageKey(qrToken),
      JSON.stringify({ key, sent, at: now }),
    );
  } catch {
    // Storage unavailable: the page's own key still covers a resend in this visit.
  }
  return key;
}

/** The server answered, so the key has done its work: the order is placed, or nothing was. */
export function forgetOrderKey(qrToken: string): void {
  try {
    window.localStorage.removeItem(orderKeyStorageKey(qrToken));
  } catch {
    // Storage unavailable: nothing was kept.
  }
}
