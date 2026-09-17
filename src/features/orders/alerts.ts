import type { Board } from './board';

/**
 * New-order alerts (spec §12) come from comparing each board refresh with the
 * previous one, not from Realtime payloads (docs/DECISIONS.md P4-16): a missed
 * event still alerts on the next refetch, and each role is alerted about what
 * it can see — the kitchen hears about an order once it is accepted.
 */

export type BoardSnapshot = { orders: Set<string>; sessions: Set<string> };

export type NewOrderAlert = {
  orderId: string;
  tableId: string;
  tableLabel: string;
  roundNumber: number;
  waiting: boolean;
};

export type NewSessionAlert = { sessionId: string; tableId: string; tableLabel: string };

export type BoardAlerts = { orders: NewOrderAlert[]; sessions: NewSessionAlert[] };

/** Orders the board shows; rejected and removed rounds never alert. */
export function snapshotOf(board: Pick<Board, 'tables'>): BoardSnapshot {
  const orders = new Set<string>();
  const sessions = new Set<string>();
  for (const table of board.tables) {
    if (!table.session) continue;
    sessions.add(table.session.id);
    for (const round of table.session.rounds) {
      if (round.status === 'accepted' || round.isWaiting) orders.add(round.id);
    }
  }
  return { orders, sessions };
}

/**
 * What's new since `previous`. No previous snapshot (first load) means nothing
 * is new. Orders placed from this device are skipped: the person who placed
 * them doesn't need a chime.
 */
export function diffBoard(
  previous: BoardSnapshot | null,
  board: Pick<Board, 'tables'>,
  ownOrderIds: ReadonlySet<string> = new Set(),
): BoardAlerts {
  if (!previous) return { orders: [], sessions: [] };
  const orders: NewOrderAlert[] = [];
  const sessions: NewSessionAlert[] = [];
  for (const table of board.tables) {
    const session = table.session;
    if (!session) continue;
    let ownSession = false;
    for (const round of session.rounds) {
      const visible = round.status === 'accepted' || round.isWaiting;
      if (!visible || previous.orders.has(round.id)) continue;
      if (ownOrderIds.has(round.id)) {
        ownSession = true;
        continue;
      }
      orders.push({
        orderId: round.id,
        tableId: table.id,
        tableLabel: table.label,
        roundNumber: round.roundNumber,
        waiting: round.isWaiting,
      });
    }
    if (!previous.sessions.has(session.id) && !ownSession) {
      sessions.push({ sessionId: session.id, tableId: table.id, tableLabel: table.label });
    }
  }
  return { orders, sessions };
}
