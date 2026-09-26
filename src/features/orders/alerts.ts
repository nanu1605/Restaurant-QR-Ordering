import type { Board, ServiceRequestType } from './board';

/**
 * New-order alerts (spec §12) come from comparing each board refresh with the
 * previous one, not from Realtime payloads (docs/DECISIONS.md P4-16): a missed
 * event still alerts on the next refetch, and each role is alerted about what
 * it can see — the kitchen hears about an order once it is accepted.
 */

export type BoardSnapshot = { orders: Set<string>; sessions: Set<string>; requests: Set<string> };

export type NewOrderAlert = {
  orderId: string;
  tableId: string;
  tableLabel: string;
  roundNumber: number;
  waiting: boolean;
};

export type NewSessionAlert = { sessionId: string; tableId: string; tableLabel: string };

export type NewRequestAlert = { tableId: string; tableLabel: string; type: ServiceRequestType };

export type BoardAlerts = {
  orders: NewOrderAlert[];
  sessions: NewSessionAlert[];
  requests: NewRequestAlert[];
};

/** Orders the board shows; rejected and removed rounds never alert. */
export function snapshotOf(board: Pick<Board, 'tables'>): BoardSnapshot {
  const orders = new Set<string>();
  const sessions = new Set<string>();
  const requests = new Set<string>();
  for (const table of board.tables) {
    for (const request of table.requests) requests.add(request.id);
    if (!table.session) continue;
    sessions.add(table.session.id);
    for (const round of table.session.rounds) {
      if (round.status === 'accepted' || round.isWaiting) orders.add(round.id);
    }
  }
  return { orders, sessions, requests };
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
  if (!previous) return { orders: [], sessions: [], requests: [] };
  const orders: NewOrderAlert[] = [];
  const sessions: NewSessionAlert[] = [];
  const requests: NewRequestAlert[] = [];
  for (const table of board.tables) {
    // A call or bill request someone already acknowledged needs no chime.
    for (const request of table.requests) {
      if (request.status !== 'open' || previous.requests.has(request.id)) continue;
      requests.push({ tableId: table.id, tableLabel: table.label, type: request.type });
    }
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
  return { orders, sessions, requests };
}
