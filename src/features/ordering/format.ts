import { DEFAULT_LOCALE } from '@/lib/config';
import type { OrderItemStatus } from '@/lib/order-status';

/** Display helpers for the customer panel (spec §13.1). */

/** "Table 5" for numbered tables; named ones ("Terrace 1") are shown as they are. */
export function tableHeading(label: string): string {
  return /^\d/.test(label) ? `Table ${label}` : label;
}

/** "2 minutes" / "90 seconds"; null when customers can't cancel at all. */
export function cancelWindowText(seconds: number): string | null {
  if (seconds <= 0) return null;
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  return `${seconds} seconds`;
}

/** The notice above "Place order" (spec §13.1 Cart page). */
export function cancelNotice(cancelWindowSeconds: number): string {
  const period = cancelWindowText(cancelWindowSeconds);
  const base = 'After you place the order, only staff can remove items.';
  return period
    ? `${base} You can cancel an item within ${period} if the kitchen hasn't started it.`
    : base;
}

/** "7:42 pm" in the restaurant's timezone. */
export function formatClockTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

/** "1:05" for a countdown in milliseconds (never negative). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** "Paneer Tikka and Butter Chicken (Full)", "A, B and C". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Why dishes left the cart (spec §13.1: show which, remove from cart). */
export function unavailableMessage(names: string[]): string {
  const one = names.length === 1;
  return `${listNames(names)} ${one ? 'is' : 'are'} no longer available, so we removed ${
    one ? 'it' : 'them'
  } from your cart.`;
}

export const NETWORK_ERROR =
  "We couldn't reach the restaurant. Check your connection and try again.";

/** Customers read "Placed" where staff read "New" (spec §13 same action, same name). */
export const CUSTOMER_STATUS_LABELS: Partial<Record<OrderItemStatus, string>> = {
  placed: 'Placed',
};
