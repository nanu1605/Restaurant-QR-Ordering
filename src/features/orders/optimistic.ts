import type { OrderItemStatus } from '@/lib/order-status';

import type { Board, BoardItem, BoardRound } from './board';

/**
 * Optimistic board updates, applied while the server action runs so taps feel
 * instant on a busy floor. The next refetch replaces them with the truth.
 */

function mapRounds(board: Board, update: (round: BoardRound) => BoardRound): Board {
  return {
    ...board,
    tables: board.tables.map((table) =>
      table.session
        ? { ...table, session: { ...table.session, rounds: table.session.rounds.map(update) } }
        : table,
    ),
  };
}

function mapItems(round: BoardRound, update: (item: BoardItem) => BoardItem): BoardRound {
  return { ...round, items: round.items.map(update) };
}

export function withItemStatus(board: Board, itemIds: string[], status: OrderItemStatus): Board {
  const ids = new Set(itemIds);
  return mapRounds(board, (round) =>
    mapItems(round, (item) => (ids.has(item.id) ? { ...item, status } : item)),
  );
}

const ON_THE_WAY: readonly OrderItemStatus[] = ['placed', 'preparing', 'ready'];

export function withRoundServed(board: Board, orderId: string): Board {
  return mapRounds(board, (round) =>
    round.id === orderId
      ? mapItems(round, (item) =>
          ON_THE_WAY.includes(item.status) ? { ...item, status: 'served' } : item,
        )
      : round,
  );
}
