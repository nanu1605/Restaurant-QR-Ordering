import { Constants, type Enums } from '@/types/database';

/** Order item statuses (spec §8.5, §10.3), straight from the Postgres enum. */
export const ORDER_ITEM_STATUSES = Constants.public.Enums.order_item_status;

export type OrderItemStatus = Enums<'order_item_status'>;

/** Forward progression used by the kitchen and board (skips allowed). */
export const ACTIVE_ITEM_STATUSES = ['placed', 'preparing', 'ready', 'served'] as const;

/** Cancelled by the customer or removed by staff: struck through, never billed. */
export const VOID_ITEM_STATUSES = ['cancelled', 'removed'] as const;

export function isVoidStatus(status: OrderItemStatus): boolean {
  return (VOID_ITEM_STATUSES as readonly string[]).includes(status);
}

/** UI labels. "New" matches the kitchen view's first column (spec §13.2). */
export const ORDER_ITEM_STATUS_LABELS: Record<OrderItemStatus, string> = {
  placed: 'New',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
  cancelled: 'Cancelled',
  removed: 'Removed',
};
