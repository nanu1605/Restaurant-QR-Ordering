import { DEFAULT_LOCALE } from '@/lib/config';

/** Display helpers shared by the panels; customer wording is in strings.ts. */

/** "Table 5" for numbered tables; named ones ("Terrace 1") are shown as they are. */
export function tableHeading(label: string): string {
  return /^\d/.test(label) ? `Table ${label}` : label;
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

/** "17 Sep 2026, 12:00 pm" in the restaurant's timezone. */
export function formatBillDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
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

/** "Pizza (Large) + Cheese burst, Olives": a dish with its option and add-ons. */
export function dishName(dish: {
  name: string;
  variant: string | null;
  addons?: readonly string[];
}): string {
  const base = dish.variant ? `${dish.name} (${dish.variant})` : dish.name;
  return dish.addons?.length ? `${base} + ${dish.addons.join(', ')}` : base;
}

/** "Paneer Tikka and Butter Chicken (Full)", "A, B and C". */
export function listNames(names: string[], and = 'and'): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${and} ${names.at(-1)}`;
}
