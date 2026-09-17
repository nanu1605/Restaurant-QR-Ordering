import { tableHeading } from '@/features/ordering/format';

export type WaiterTone = 'free' | 'busy' | 'off';

/**
 * Available / Busy — Table 3 / Off duty (spec §13.3 Waiters, §8.2
 * max_tables_per_waiter). Shared by the Waiters page and the live board.
 */
export function waiterStatus(
  waiter: { onDuty: boolean; openTables: string[] },
  maxTables: number,
): { label: string; tone: WaiterTone } {
  const tables = waiter.openTables.map(tableHeading).join(', ');
  if (!waiter.onDuty) return { label: tables ? `Off duty · ${tables}` : 'Off duty', tone: 'off' };
  if (waiter.openTables.length >= maxTables) return { label: `Busy — ${tables}`, tone: 'busy' };
  return { label: tables ? `Available · ${tables}` : 'Available', tone: 'free' };
}
