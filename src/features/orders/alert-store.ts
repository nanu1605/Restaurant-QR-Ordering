'use client';

import { useSyncExternalStore } from 'react';

/**
 * Small client stores behind the new-order alerts (spec §12): which tables are
 * highlighted right now, and which orders this device placed itself (no chime
 * for those).
 */

const HIGHLIGHT_MS = 8_000;

const highlighted = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function highlightTables(tableIds: string[]) {
  if (tableIds.length === 0) return;
  const until = Date.now() + HIGHLIGHT_MS;
  for (const id of tableIds) highlighted.set(id, until);
  emit();
  setTimeout(() => {
    const now = Date.now();
    for (const [id, expires] of highlighted) if (expires <= now) highlighted.delete(id);
    emit();
  }, HIGHLIGHT_MS + 50);
}

/** True for a few seconds after a new order arrives at this table. */
export function useHighlighted(tableId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => highlighted.has(tableId),
    () => false,
  );
}

const ownOrders = new Set<string>();

/** Orders placed from this device; they don't chime here. */
export function rememberOwnOrder(orderId: string) {
  ownOrders.add(orderId);
}

export function ownOrderIds(): ReadonlySet<string> {
  return ownOrders;
}
