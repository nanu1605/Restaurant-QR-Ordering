import type { Board, BoardItem } from './board';
import { type ActiveStatus, activeItems } from './board-view';

/**
 * Kitchen view tickets (spec §13.2): one round for one table, oldest first, in
 * three columns. A round whose dishes are at different stages shows up once per
 * stage, so ready dishes never hide behind new ones (docs/DECISIONS.md P4-17).
 * Only accepted rounds count, whoever is looking (spec §10.2).
 */

export type KitchenColumn = Exclude<ActiveStatus, 'served'>;

export const KITCHEN_COLUMNS: { status: KitchenColumn; label: string }[] = [
  { status: 'placed', label: 'New' },
  { status: 'preparing', label: 'Preparing' },
  { status: 'ready', label: 'Ready' },
];

/** Tickets turn to the warning colour after this long (spec §13.2). */
export const LATE_AFTER_MINUTES = 15;

export type KitchenTicket = {
  key: string;
  orderId: string;
  tableId: string;
  tableLabel: string;
  roundNumber: number;
  status: KitchenColumn;
  acceptedAt: string;
  note: string | null;
  items: BoardItem[];
};

export function kitchenTickets(
  board: Pick<Board, 'tables'>,
): Record<KitchenColumn, KitchenTicket[]> {
  const columns: Record<KitchenColumn, KitchenTicket[]> = { placed: [], preparing: [], ready: [] };
  for (const table of board.tables) {
    for (const round of table.session?.rounds ?? []) {
      const items = activeItems(round);
      for (const { status } of KITCHEN_COLUMNS) {
        const atStatus = items.filter((item) => item.status === status);
        if (atStatus.length === 0) continue;
        columns[status].push({
          key: `${round.id}:${status}`,
          orderId: round.id,
          tableId: table.id,
          tableLabel: table.label,
          roundNumber: round.roundNumber,
          status,
          acceptedAt: round.acceptedAt ?? round.createdAt,
          note: round.customerNote,
          items: atStatus,
        });
      }
    }
  }
  for (const tickets of Object.values(columns)) {
    tickets.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.key.localeCompare(b.key));
  }
  return columns;
}

export function isLate(acceptedAt: string, nowMs: number): boolean {
  return nowMs - Date.parse(acceptedAt) >= LATE_AFTER_MINUTES * 60_000;
}
