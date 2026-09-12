'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';

import { reconcileCart, useCart } from '../cart';
import { unavailableMessage } from '../format';
import type { CustomerCategory } from '../types';

/**
 * The table's cart, checked against the menu the page was rendered with:
 * dishes that went out of stock or off the menu since they were added are
 * removed, with a message naming them (spec §13.1).
 */
export function useReconciledCart(qrToken: string, menu: CustomerCategory[]) {
  const [cart, update] = useCart(qrToken);

  useEffect(() => {
    let removed: string[] = [];
    update((current) => {
      const result = reconcileCart(current, menu);
      removed = result.removed;
      return result.cart;
    });
    if (removed.length > 0) toast(unavailableMessage(removed));
  }, [menu, update]);

  return [cart, update] as const;
}
