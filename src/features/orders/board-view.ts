import { ACTIVE_ITEM_STATUSES, type OrderItemStatus } from '@/lib/order-status';

import type { Board, BoardItem, BoardRound, BoardTable, BoardWaiter } from './board';

/**
 * What the board shows, worked out from the board data (spec §10.4, §13.2).
 * Pure functions, so every screen derives the same state and colours.
 */

export type ActiveStatus = (typeof ACTIVE_ITEM_STATUSES)[number];

/** Table card states (spec §10.4), most urgent first. */
export type TableState = 'needs_approval' | 'in_progress' | 'all_served' | 'idle' | 'free';

export const TABLE_STATE_LABELS: Record<TableState, string> = {
  needs_approval: 'Needs approval',
  in_progress: 'In progress',
  all_served: 'All served',
  idle: 'No active dishes',
  free: 'Free',
};

/** Dishes of accepted rounds that are still on the bill: placed … served. */
export function activeItems(round: BoardRound): BoardItem[] {
  if (round.status !== 'accepted') return [];
  return round.items.filter((item) => isActiveStatus(item.status));
}

export function isActiveStatus(status: OrderItemStatus): status is ActiveStatus {
  return (ACTIVE_ITEM_STATUSES as readonly string[]).includes(status);
}

function sessionItems(table: BoardTable): BoardItem[] {
  return table.session?.rounds.flatMap(activeItems) ?? [];
}

export function tableState(table: BoardTable): TableState {
  const session = table.session;
  if (!session) return 'free';
  if (session.waitingCount > 0) return 'needs_approval';
  const items = sessionItems(table);
  if (items.some((item) => item.status !== 'served')) return 'in_progress';
  if (items.length > 0) return 'all_served';
  return 'idle';
}

/** The least-advanced status among dishes still on their way, else served (spec §10.4). */
export function leastAdvancedStatus(items: BoardItem[]): ActiveStatus | null {
  let least: ActiveStatus | null = null;
  for (const item of items) {
    if (!isActiveStatus(item.status)) continue;
    if (least === null || stepOf(item.status) < stepOf(least)) least = item.status;
  }
  return least;
}

export function stepOf(status: ActiveStatus): number {
  return ACTIVE_ITEM_STATUSES.indexOf(status);
}

/** The next status on the way to the table, or null once served. */
export function nextStatus(status: ActiveStatus): Exclude<ActiveStatus, 'placed'> | null {
  switch (status) {
    case 'placed':
      return 'preparing';
    case 'preparing':
      return 'ready';
    case 'ready':
      return 'served';
    default:
      return null;
  }
}

/** Card edge colour: attention while waiting, else the least-advanced dish. */
export type TableTone = ActiveStatus | 'attention' | 'free';

export function tableTone(table: BoardTable): TableTone {
  const state = tableState(table);
  if (state === 'free') return 'free';
  if (state === 'needs_approval') return 'attention';
  return leastAdvancedStatus(sessionItems(table)) ?? 'free';
}

/** Dishes by status (quantities), for the card's summary line. */
export function statusCounts(table: BoardTable): Record<ActiveStatus, number> {
  const counts: Record<ActiveStatus, number> = { placed: 0, preparing: 0, ready: 0, served: 0 };
  for (const item of sessionItems(table)) {
    if (isActiveStatus(item.status)) counts[item.status] += item.quantity;
  }
  return counts;
}

/** Whole minutes since `iso`, using the server clock offset. */
export function minutesSince(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 60_000));
}

/** "12 min", "1 h 05 min". */
export function formatElapsed(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

// ─── Filters (spec §13.2) ───────────────────────────────────────────────────

export type BoardFilter =
  'all' | 'mine' | 'needs_approval' | 'unassigned' | 'in_progress' | 'all_served';

export const FILTER_LABELS: Record<BoardFilter, string> = {
  all: 'All',
  mine: 'My tables',
  needs_approval: 'Needs approval',
  unassigned: 'Unassigned',
  in_progress: 'In progress',
  all_served: 'All served',
};

/** The chips a user sees: "My tables" only with a waiter profile, no approvals for the kitchen. */
export function availableFilters(board: Pick<Board, 'role' | 'myWaiterId'>): BoardFilter[] {
  return (Object.keys(FILTER_LABELS) as BoardFilter[]).filter((filter) => {
    if (filter === 'mine') return board.myWaiterId !== null;
    if (filter === 'needs_approval') return board.role !== 'kitchen';
    return true;
  });
}

/** Waiter logins linked to a profile start on "My tables" (spec §10.7). */
export function defaultFilter(board: Pick<Board, 'myWaiterId'>): BoardFilter {
  return board.myWaiterId ? 'mine' : 'all';
}

export function matchesFilter(
  table: BoardTable,
  filter: BoardFilter,
  myWaiterId: string | null,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'mine':
      return myWaiterId !== null && table.session?.assignedWaiterId === myWaiterId;
    case 'unassigned':
      return table.session !== null && table.session.assignedWaiterId === null;
    default:
      return tableState(table) === filter;
  }
}

// ─── Waiters (spec §8.5, §10.7) ─────────────────────────────────────────────

export type WaiterStatus = 'available' | 'busy' | 'off_duty';

export type WaiterAvailability = BoardWaiter & {
  /** Labels of the open tables they're handling, in table order. */
  tables: string[];
  status: WaiterStatus;
};

/** Available while on duty and under the table limit; off-duty waiters keep their tables. */
export function waiterAvailability(board: Pick<Board, 'tables' | 'waiters' | 'settings'>) {
  const tablesByWaiter = new Map<string, string[]>();
  for (const table of board.tables) {
    const waiterId = table.session?.assignedWaiterId;
    if (!waiterId) continue;
    tablesByWaiter.set(waiterId, [...(tablesByWaiter.get(waiterId) ?? []), table.label]);
  }
  return board.waiters.map((waiter): WaiterAvailability => {
    const tables = tablesByWaiter.get(waiter.id) ?? [];
    const status: WaiterStatus = !waiter.onDuty
      ? 'off_duty'
      : tables.length >= board.settings.maxTablesPerWaiter
        ? 'busy'
        : 'available';
    return { ...waiter, tables, status };
  });
}

/** Waiter name for a session, or null while unassigned (or the profile was deleted). */
export function waiterName(board: Pick<Board, 'waiters'>, waiterId: string | null): string | null {
  if (!waiterId) return null;
  return board.waiters.find((waiter) => waiter.id === waiterId)?.name ?? null;
}
