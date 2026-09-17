import { describe, expect, it } from 'vitest';

import { connectionState } from '@/features/live/connection';
import { diffBoard, snapshotOf } from '@/features/orders/alerts';
import {
  type Board,
  type BoardItem,
  type BoardRound,
  type BoardTable,
  parseBoard,
} from '@/features/orders/board';
import {
  availableFilters,
  defaultFilter,
  formatElapsed,
  leastAdvancedStatus,
  matchesFilter,
  minutesSince,
  nextStatus,
  statusCounts,
  tableState,
  tableTone,
  waiterAvailability,
  waiterName,
} from '@/features/orders/board-view';
import { isLate, kitchenTickets } from '@/features/orders/kitchen';
import { withItemStatus, withRoundServed } from '@/features/orders/optimistic';
import {
  forwardStatusSchema,
  reasonSchema,
  removeItemSchema,
  staffOrderSchema,
} from '@/features/orders/schemas';
import { waiterStatus } from '@/features/waiters/status';
import { dbErrorMessage } from '@/lib/db-errors';

// ─── Fixtures ───────────────────────────────────────────────────────────────

let seq = 0;
const id = (prefix: string) => `${prefix}-${++seq}`;

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: id('item'),
    name: 'Paneer Tikka',
    variant: null,
    foodType: 'veg',
    quantity: 1,
    note: null,
    status: 'placed',
    removedReason: null,
    removedByName: null,
    ...overrides,
  };
}

function round(overrides: Partial<BoardRound> = {}): BoardRound {
  return {
    id: id('order'),
    roundNumber: 1,
    status: 'accepted',
    placedVia: 'customer',
    createdAt: '2026-09-13T12:00:00.000Z',
    acceptedAt: '2026-09-13T12:00:00.000Z',
    customerNote: null,
    rejectReason: null,
    removedReason: null,
    removedByName: null,
    isWaiting: false,
    items: [item()],
    ...overrides,
  };
}

function table(
  label: string,
  session: Partial<NonNullable<BoardTable['session']>> | null = null,
): BoardTable {
  return {
    id: id('table'),
    label,
    sortOrder: Number(label) || 0,
    session: session && {
      id: id('session'),
      openedAt: '2026-09-13T12:00:00.000Z',
      isApproved: true,
      assignedWaiterId: null,
      waitingCount: 0,
      rounds: [],
      ...session,
    },
  };
}

function board(overrides: Partial<Board> = {}): Board {
  return {
    now: '2026-09-13T12:30:00.000Z',
    fetchedAt: Date.parse('2026-09-13T12:30:00.000Z'),
    timezone: 'Asia/Kolkata',
    role: 'waiter',
    myWaiterId: null,
    canOrder: true,
    settings: {
      requireFirstOrderApproval: true,
      maxTablesPerWaiter: 1,
      staffCanRemoveServedItems: false,
    },
    tables: [],
    waiters: [],
    ...overrides,
  };
}

// ─── Board view ─────────────────────────────────────────────────────────────

describe('tableState', () => {
  it('is free without a session', () => {
    expect(tableState(table('1'))).toBe('free');
  });

  it('needs approval while a round is waiting, ahead of everything else', () => {
    const t = table('1', {
      waitingCount: 1,
      rounds: [round({ items: [item({ status: 'preparing' })] })],
    });
    expect(tableState(t)).toBe('needs_approval');
  });

  it('is in progress while an accepted dish is on its way', () => {
    const t = table('1', { rounds: [round({ items: [item({ status: 'served' }), item()] })] });
    expect(tableState(t)).toBe('in_progress');
  });

  it('is all served once every active dish is served', () => {
    const t = table('1', {
      rounds: [round({ items: [item({ status: 'served' }), item({ status: 'removed' })] })],
    });
    expect(tableState(t)).toBe('all_served');
  });

  it('has no active dishes after a reject or a full cancellation', () => {
    const t = table('1', {
      rounds: [
        round({ status: 'rejected', items: [item({ status: 'cancelled' })] }),
        round({ status: 'pending_approval', items: [item({ status: 'cancelled' })] }),
      ],
    });
    expect(tableState(t)).toBe('idle');
  });

  it('ignores dishes of rounds that were never accepted', () => {
    const t = table('1', { rounds: [round({ status: 'removed', items: [item()] })] });
    expect(tableState(t)).toBe('idle');
  });
});

describe('colours and counts', () => {
  it('takes the least-advanced dish still on its way', () => {
    expect(leastAdvancedStatus([item({ status: 'ready' }), item({ status: 'preparing' })])).toBe(
      'preparing',
    );
    expect(leastAdvancedStatus([item({ status: 'served' })])).toBe('served');
    expect(leastAdvancedStatus([item({ status: 'cancelled' })])).toBeNull();
  });

  it('gives the card edge attention while waiting, else the dish colour', () => {
    expect(tableTone(table('1'))).toBe('free');
    expect(tableTone(table('1', { waitingCount: 2 }))).toBe('attention');
    expect(tableTone(table('1', { rounds: [round({ items: [item({ status: 'ready' })] })] }))).toBe(
      'ready',
    );
    expect(tableTone(table('1', { rounds: [] }))).toBe('free');
  });

  it('counts quantities of active dishes by status', () => {
    const t = table('1', {
      rounds: [
        round({
          items: [
            item({ quantity: 2 }),
            item({ status: 'served', quantity: 3 }),
            item({ status: 'removed', quantity: 5 }),
          ],
        }),
        round({ status: 'rejected', items: [item({ quantity: 7 })] }),
      ],
    });
    expect(statusCounts(t)).toEqual({ placed: 2, preparing: 0, ready: 0, served: 3 });
  });

  it('moves dishes forward one step at a time', () => {
    expect(nextStatus('placed')).toBe('preparing');
    expect(nextStatus('preparing')).toBe('ready');
    expect(nextStatus('ready')).toBe('served');
    expect(nextStatus('served')).toBeNull();
  });

  it('formats elapsed time from the server clock', () => {
    const now = Date.parse('2026-09-13T13:05:30.000Z');
    expect(minutesSince('2026-09-13T12:00:00.000Z', now)).toBe(65);
    expect(minutesSince('2026-09-13T14:00:00.000Z', now)).toBe(0);
    expect(formatElapsed(12)).toBe('12 min');
    expect(formatElapsed(65)).toBe('1 h 05 min');
  });
});

describe('filters', () => {
  const mine = table('1', { assignedWaiterId: 'w-ravi', rounds: [round()] });
  const unassigned = table('2', { rounds: [round({ items: [item({ status: 'served' })] })] });
  const waiting = table('3', { waitingCount: 1 });
  const free = table('4');

  it('shows "My tables" only to waiter profiles and hides approvals from the kitchen', () => {
    expect(availableFilters({ role: 'waiter', myWaiterId: 'w-ravi' })).toEqual([
      'all',
      'mine',
      'needs_approval',
      'unassigned',
      'in_progress',
      'all_served',
    ]);
    expect(availableFilters({ role: 'manager', myWaiterId: null })).not.toContain('mine');
    expect(availableFilters({ role: 'kitchen', myWaiterId: null })).not.toContain('needs_approval');
  });

  it('starts linked waiters on their own tables', () => {
    expect(defaultFilter({ myWaiterId: 'w-ravi' })).toBe('mine');
    expect(defaultFilter({ myWaiterId: null })).toBe('all');
  });

  it('matches each filter', () => {
    const all = [mine, unassigned, waiting, free];
    const labels = (filter: Parameters<typeof matchesFilter>[1]) =>
      all.filter((t) => matchesFilter(t, filter, 'w-ravi')).map((t) => t.label);
    expect(labels('all')).toEqual(['1', '2', '3', '4']);
    expect(labels('mine')).toEqual(['1']);
    expect(labels('unassigned')).toEqual(['2', '3']);
    expect(labels('needs_approval')).toEqual(['3']);
    expect(labels('in_progress')).toEqual(['1']);
    expect(labels('all_served')).toEqual(['2']);
    expect(matchesFilter(mine, 'mine', null)).toBe(false);
  });
});

describe('waiters', () => {
  const b = board({
    settings: {
      requireFirstOrderApproval: true,
      maxTablesPerWaiter: 1,
      staffCanRemoveServedItems: false,
    },
    waiters: [
      { id: 'w-anita', name: 'Anita', onDuty: true },
      { id: 'w-ravi', name: 'Ravi', onDuty: true },
      { id: 'w-suresh', name: 'Suresh', onDuty: false },
    ],
    tables: [
      table('3', { assignedWaiterId: 'w-ravi' }),
      table('4', { assignedWaiterId: 'w-suresh' }),
      table('5'),
    ],
  });

  it('works out who is available, busy or off duty, with their tables', () => {
    expect(waiterAvailability(b)).toEqual([
      { id: 'w-anita', name: 'Anita', onDuty: true, tables: [], status: 'available' },
      { id: 'w-ravi', name: 'Ravi', onDuty: true, tables: ['3'], status: 'busy' },
      { id: 'w-suresh', name: 'Suresh', onDuty: false, tables: ['4'], status: 'off_duty' },
    ]);
    expect(
      waiterAvailability({ ...b, settings: { ...b.settings, maxTablesPerWaiter: 2 } })[1]!.status,
    ).toBe('available');
  });

  it('names the waiter of a session', () => {
    expect(waiterName(b, 'w-ravi')).toBe('Ravi');
    expect(waiterName(b, null)).toBeNull();
    expect(waiterName(b, 'gone')).toBeNull();
  });

  it('labels waiter status for the Waiters page and the strip', () => {
    expect(waiterStatus({ onDuty: true, openTables: [] }, 1)).toEqual({
      label: 'Available',
      tone: 'free',
    });
    expect(waiterStatus({ onDuty: true, openTables: ['3'] }, 1)).toEqual({
      label: 'Busy — Table 3',
      tone: 'busy',
    });
    expect(waiterStatus({ onDuty: true, openTables: ['Terrace 2'] }, 2)).toEqual({
      label: 'Available · Terrace 2',
      tone: 'free',
    });
    expect(waiterStatus({ onDuty: false, openTables: ['3', '4'] }, 1)).toEqual({
      label: 'Off duty · Table 3, Table 4',
      tone: 'off',
    });
  });
});

// ─── Kitchen view ───────────────────────────────────────────────────────────

describe('kitchenTickets', () => {
  it('splits a round per status, skips served and void dishes, oldest first', () => {
    const late = round({
      roundNumber: 2,
      acceptedAt: '2026-09-13T11:00:00.000Z',
      items: [
        item({ name: 'Naan', status: 'placed' }),
        item({ name: 'Dal', status: 'ready' }),
        item({ name: 'Soup', status: 'served' }),
        item({ name: 'Kofta', status: 'removed' }),
      ],
    });
    const early = round({ acceptedAt: null, createdAt: '2026-09-13T10:00:00.000Z' });
    const b = board({ tables: [table('5', { rounds: [late] }), table('6', { rounds: [early] })] });

    const columns = kitchenTickets(b);
    expect(columns.placed.map((t) => [t.tableLabel, t.roundNumber])).toEqual([
      ['6', 1],
      ['5', 2],
    ]);
    expect(columns.placed[1]!.items.map((i) => i.name)).toEqual(['Naan']);
    expect(columns.ready.map((t) => t.items.map((i) => i.name))).toEqual([['Dal']]);
    expect(columns.preparing).toEqual([]);
    expect(columns.placed[0]!.acceptedAt).toBe('2026-09-13T10:00:00.000Z');
  });

  it('shows only accepted rounds, whoever is looking', () => {
    const b = board({
      role: 'manager',
      tables: [
        table('5', {
          rounds: [
            round({ status: 'pending_approval', isWaiting: true }),
            round({ status: 'rejected' }),
          ],
        }),
      ],
    });
    const columns = kitchenTickets(b);
    expect([...columns.placed, ...columns.preparing, ...columns.ready]).toEqual([]);
  });

  it('marks tickets late after 15 minutes', () => {
    const accepted = '2026-09-13T12:00:00.000Z';
    expect(isLate(accepted, Date.parse('2026-09-13T12:14:59.000Z'))).toBe(false);
    expect(isLate(accepted, Date.parse('2026-09-13T12:15:00.000Z'))).toBe(true);
  });
});

// ─── Alerts ─────────────────────────────────────────────────────────────────

describe('diffBoard', () => {
  it('stays quiet on the first load', () => {
    const b = board({ tables: [table('5', { rounds: [round()] })] });
    expect(diffBoard(null, b)).toEqual({ orders: [], sessions: [] });
  });

  it('reports new accepted and waiting orders and new sessions', () => {
    const before = board({ tables: [table('5'), table('6')] });
    const accepted = round();
    const waiting = round({ status: 'pending_approval', isWaiting: true });
    const t5 = { ...before.tables[0]!, session: table('5', { rounds: [accepted] }).session };
    const t6 = { ...before.tables[1]!, session: table('6', { rounds: [waiting] }).session };
    const after = board({ tables: [t5, t6] });

    const alerts = diffBoard(snapshotOf(before), after);
    expect(alerts.orders.map((o) => [o.tableLabel, o.waiting])).toEqual([
      ['5', false],
      ['6', true],
    ]);
    expect(alerts.sessions.map((s) => s.tableLabel)).toEqual(['5', '6']);
  });

  it('does not alert again when a waiting order is approved', () => {
    const waiting = round({ status: 'pending_approval', isWaiting: true });
    const t = table('5', { rounds: [waiting] });
    const approved = {
      ...t,
      session: {
        ...t.session!,
        rounds: [{ ...waiting, status: 'accepted' as const, isWaiting: false }],
      },
    };
    expect(
      diffBoard(snapshotOf(board({ tables: [t] })), board({ tables: [approved] })).orders,
    ).toEqual([]);
  });

  it('alerts the kitchen when an order it could not see is approved', () => {
    const t = table('5', { waitingCount: 1, rounds: [] });
    const accepted = round();
    const later = { ...t, session: { ...t.session!, waitingCount: 0, rounds: [accepted] } };
    const alerts = diffBoard(snapshotOf(board({ tables: [t] })), board({ tables: [later] }));
    expect(alerts.orders.map((o) => o.orderId)).toEqual([accepted.id]);
    expect(alerts.sessions).toEqual([]);
  });

  it('skips orders placed on this device, and the session they opened', () => {
    const mineRound = round({ placedVia: 'staff' });
    const after = board({ tables: [table('5', { rounds: [mineRound] })] });
    const alerts = diffBoard(snapshotOf(board({ tables: [] })), after, new Set([mineRound.id]));
    expect(alerts).toEqual({ orders: [], sessions: [] });
  });

  it('never alerts for rejected, removed or fully cancelled rounds', () => {
    const after = board({
      tables: [
        table('5', {
          rounds: [
            round({ status: 'rejected' }),
            round({ status: 'removed' }),
            round({ status: 'pending_approval', isWaiting: false }),
          ],
        }),
      ],
    });
    expect(diffBoard(snapshotOf(board()), after).orders).toEqual([]);
  });
});

// ─── Connection and optimistic updates ─────────────────────────────────────

describe('connectionState', () => {
  it('maps the network and channel to the header indicator', () => {
    expect(connectionState(false, 'subscribed')).toBe('offline');
    expect(connectionState(true, 'subscribed')).toBe('live');
    expect(connectionState(true, 'connecting')).toBe('reconnecting');
    expect(connectionState(true, 'error')).toBe('reconnecting');
  });
});

describe('optimistic updates', () => {
  it('moves the given dishes only', () => {
    const a = item();
    const b2 = item();
    const before = board({ tables: [table('5', { rounds: [round({ items: [a, b2] })] })] });
    const after = withItemStatus(before, [a.id], 'preparing');
    expect(after.tables[0]!.session!.rounds[0]!.items.map((i) => i.status)).toEqual([
      'preparing',
      'placed',
    ]);
    expect(before.tables[0]!.session!.rounds[0]!.items[0]!.status).toBe('placed');
  });

  it('serves a round without touching void dishes or other rounds', () => {
    const target = round({
      items: [item(), item({ status: 'ready' }), item({ status: 'cancelled' })],
    });
    const other = round();
    const before = board({ tables: [table('5', { rounds: [target, other] })] });
    const after = withRoundServed(before, target.id);
    const [first, second] = after.tables[0]!.session!.rounds;
    expect(first!.items.map((i) => i.status)).toEqual(['served', 'served', 'cancelled']);
    expect(second!.items.map((i) => i.status)).toEqual(['placed']);
  });
});

// ─── Board payload ──────────────────────────────────────────────────────────

describe('parseBoard', () => {
  const payload = {
    now: '2026-09-13T12:30:00+00:00',
    timezone: 'Asia/Kolkata',
    role: 'kitchen',
    my_waiter_id: null,
    access_state: 'read_only',
    settings: {
      require_first_order_approval: true,
      max_tables_per_waiter: 2,
      staff_can_remove_served_items: false,
    },
    tables: [
      { id: 't1', label: '1', sort_order: 1, session: null },
      {
        id: 't5',
        label: '5',
        sort_order: 5,
        session: {
          id: 's1',
          opened_at: '2026-09-13T12:00:00+00:00',
          is_approved: true,
          assigned_waiter_id: 'w1',
          waiting_count: 1,
          rounds: [
            {
              id: 'o1',
              round_number: 1,
              status: 'accepted',
              placed_via: 'staff',
              created_at: '2026-09-13T12:01:00+00:00',
              accepted_at: '2026-09-13T12:01:00+00:00',
              customer_note: null,
              reject_reason: null,
              removed_reason: null,
              removed_by_name: null,
              is_waiting: false,
              items: [
                {
                  id: 'i1',
                  name: 'Butter Chicken',
                  variant: 'Full',
                  food_type: 'non_veg',
                  quantity: 2,
                  note: 'Less spicy',
                  status: 'removed',
                  removed_reason: 'Wrong item',
                  removed_by_name: 'Manoj',
                },
              ],
            },
          ],
        },
      },
    ],
    waiters: [{ id: 'w1', name: 'Ravi', on_duty: true }],
  };

  it('maps the snake_case payload', () => {
    const b = parseBoard(payload);
    expect(b.canOrder).toBe(false);
    expect(b.settings.maxTablesPerWaiter).toBe(2);
    expect(b.tables[0]!.session).toBeNull();
    expect(b.tables[1]!.session).toMatchObject({ waitingCount: 1, assignedWaiterId: 'w1' });
    expect(b.tables[1]!.session!.rounds[0]).toMatchObject({ placedVia: 'staff', isWaiting: false });
    expect(b.tables[1]!.session!.rounds[0]!.items[0]).toEqual({
      id: 'i1',
      name: 'Butter Chicken',
      variant: 'Full',
      foodType: 'non_veg',
      quantity: 2,
      note: 'Less spicy',
      status: 'removed',
      removedReason: 'Wrong item',
      removedByName: 'Manoj',
    });
    expect(b.waiters).toEqual([{ id: 'w1', name: 'Ravi', onDuty: true }]);
  });

  it('fails loudly on a payload it does not understand', () => {
    expect(() => parseBoard({ ...payload, role: 'chef' })).toThrow();
  });
});

// ─── Schemas and messages ───────────────────────────────────────────────────

describe('schemas', () => {
  it('trims reasons and keeps them to 1–200 characters', () => {
    expect(reasonSchema.parse('  Wrong item ')).toBe('Wrong item');
    expect(reasonSchema.safeParse('   ').success).toBe(false);
    expect(reasonSchema.safeParse('x'.repeat(201)).success).toBe(false);
  });

  it('only moves dishes forward', () => {
    expect(forwardStatusSchema.safeParse('ready').success).toBe(true);
    expect(forwardStatusSchema.safeParse('placed').success).toBe(false);
    expect(forwardStatusSchema.safeParse('cancelled').success).toBe(false);
  });

  it('checks dish removals and staff orders', () => {
    const itemId = '6f1f4a0e-3a6b-4c1b-8d7e-2f1a0c9b8d7e';
    expect(
      removeItemSchema.safeParse({ itemId, quantity: 1, reason: 'Out of stock' }).success,
    ).toBe(true);
    expect(removeItemSchema.safeParse({ itemId, quantity: 0, reason: 'x' }).success).toBe(false);
    const order = {
      tableId: itemId,
      idempotencyKey: 'abcdef12-key',
      lines: [{ menuItemId: itemId, variantId: null, quantity: 2 }],
    };
    expect(staffOrderSchema.safeParse(order).success).toBe(true);
    expect(staffOrderSchema.safeParse({ ...order, tableId: 'table-5' }).success).toBe(false);
    expect(staffOrderSchema.safeParse({ ...order, lines: [] }).success).toBe(false);
  });
});

describe('live board messages', () => {
  const message = (code: string, details?: string) =>
    dbErrorMessage({ code: 'P0001', message: code, details });

  it('has a message for every new code', () => {
    for (const code of [
      'SESSION_NOT_OPEN',
      'ORDER_NOT_PENDING',
      'ORDER_NOT_ACCEPTED',
      'ORDER_NOT_ACTIVE',
      'ITEM_NOT_ACTIVE',
      'INVALID_STATUS_CHANGE',
      'REQUIRES_MANAGER',
      'REASON_REQUIRED',
      'ORDERING_UNAVAILABLE',
      'ITEM_UNAVAILABLE',
    ]) {
      expect(message(code), code).toBeTruthy();
    }
  });

  it('names busy tables and unavailable waiters', () => {
    expect(message('WAITER_BUSY', '3')).toBe('This waiter is already handling Table 3.');
    expect(message('WAITER_BUSY', '3, 4')).toBe('This waiter is already handling Tables 3, 4.');
    expect(message('WAITER_NOT_AVAILABLE', 'Ravi Kumar')).toBe(
      "Ravi Kumar isn't on duty. Choose someone else.",
    );
    expect(message('WAITER_NOT_AVAILABLE')).toBe("This waiter isn't on duty. Choose someone else.");
  });
});
