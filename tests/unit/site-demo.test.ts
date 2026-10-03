import { describe, expect, it } from 'vitest';

import {
  billTotals,
  canMakeBill,
  cartCount,
  cartTotal,
  demoBill,
  demoReducer,
  INITIAL_DEMO,
  nextHint,
  type DemoAction,
  type DemoState,
} from '@/features/site/demo/machine';

function play(...actions: DemoAction[]): DemoState {
  return actions.reduce(demoReducer, INITIAL_DEMO);
}

const add = (dishId: string): DemoAction => ({ type: 'add', dishId });
const remove = (dishId: string): DemoAction => ({ type: 'remove', dishId });
const place: DemoAction = { type: 'place', at: '7:42 pm' };

/** Table 5 with one Paneer Tikka placed and every dish served. */
function served(): DemoState {
  return play(
    add('paneer-tikka'),
    place,
    { type: 'advance', lineId: '1-paneer-tikka' },
    { type: 'advance', lineId: '1-paneer-tikka' },
    { type: 'advance', lineId: '1-paneer-tikka' },
  );
}

describe('the demo cart', () => {
  it('adds and removes dishes, with the count and total in paise', () => {
    const state = play(add('paneer-tikka'), add('paneer-tikka'), add('butter-naan'));
    expect(cartCount(state)).toBe(3);
    expect(cartTotal(state)).toBe(2 * 28000 + 6000);
    expect(state.message).toBe('Butter Naan added. 1 in cart.');

    const less = play(add('paneer-tikka'), add('paneer-tikka'), remove('paneer-tikka'));
    expect(less.cart).toEqual({ 'paneer-tikka': 1 });
    const gone = demoReducer(less, remove('paneer-tikka'));
    expect(gone.cart).toEqual({});
    expect(gone.message).toBe('Paneer Tikka removed from cart.');
    expect(demoReducer(gone, remove('paneer-tikka'))).toBe(gone);
  });

  it('placing empties the cart and creates a round for the kitchen', () => {
    const first = play(
      add('dal-makhani'),
      add('butter-naan'),
      { type: 'view', view: 'cart' },
      place,
    );
    expect(first.cart).toEqual({});
    expect(first.view).toBe('orders');
    expect(first.message).toBe('Order sent to the kitchen.');
    expect(first.rounds).toEqual([
      {
        number: 1,
        at: '7:42 pm',
        lines: [
          { id: '1-dal-makhani', dishId: 'dal-makhani', quantity: 1, status: 'placed' },
          { id: '1-butter-naan', dishId: 'butter-naan', quantity: 1, status: 'placed' },
        ],
      },
    ]);

    const second = play(add('dal-makhani'), place, add('masala-chai'), place);
    expect(second.rounds.map((round) => round.number)).toEqual([1, 2]);
    expect(second.rounds[1]!.lines[0]!.id).toBe('2-masala-chai');
    // An empty cart places nothing.
    expect(demoReducer(second, place)).toBe(second);
  });
});

describe('the kitchen', () => {
  it('moves a dish placed → preparing → ready → served and never back', () => {
    let state = play(add('paneer-tikka'), place);
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++) {
      state = demoReducer(state, { type: 'advance', lineId: '1-paneer-tikka' });
      statuses.push(state.rounds[0]!.lines[0]!.status);
    }
    expect(statuses).toEqual(['preparing', 'ready', 'served', 'served']);
    expect(state.message).toBe('Paneer Tikka has been served.');
  });

  it('moves a whole ticket at its lowest status', () => {
    let state = play(add('paneer-tikka'), add('chicken-65'), place);
    state = demoReducer(state, { type: 'advance', lineId: '1-paneer-tikka' });
    // Only Chicken 65 is still placed, so "Start all" moves just that one.
    state = demoReducer(state, { type: 'advanceTicket', round: 1 });
    expect(state.rounds[0]!.lines.map((line) => line.status)).toEqual(['preparing', 'preparing']);
    state = demoReducer(state, { type: 'advanceTicket', round: 1 });
    expect(state.rounds[0]!.lines.map((line) => line.status)).toEqual(['ready', 'ready']);
    expect(state.message).toBe('Paneer Tikka and Chicken 65 are ready.');
  });

  it('shows a waiter call until it is done', () => {
    const before = play({ type: 'request', kind: 'call_waiter' });
    expect(before.requests).toEqual([]); // nothing ordered yet
    const calling = play(add('masala-chai'), place, { type: 'request', kind: 'call_waiter' });
    expect(calling.requests).toEqual(['call_waiter']);
    expect(calling.message).toBe('Table 5 is calling a waiter.');
    expect(demoReducer(calling, { type: 'request', kind: 'call_waiter' })).toBe(calling);
    const done = demoReducer(calling, { type: 'resolve', kind: 'call_waiter' });
    expect(done.requests).toEqual([]);
  });
});

describe('the bill', () => {
  it('adds GST at 5%, rounded half up to whole paise', () => {
    expect(billTotals(28000)).toEqual({ subtotalPaise: 28000, gstPaise: 1400, totalPaise: 29400 });
    expect(billTotals(1010)).toEqual({ subtotalPaise: 1010, gstPaise: 51, totalPaise: 1061 });
    expect(billTotals(1009)).toEqual({ subtotalPaise: 1009, gstPaise: 50, totalPaise: 1059 });
  });

  it('is made only once every dish is served, with one line per dish', () => {
    const cooking = play(add('paneer-tikka'), place);
    expect(canMakeBill(cooking)).toBe(false);
    expect(demoReducer(cooking, { type: 'makeBill' })).toBe(cooking);

    let state = play(add('butter-naan'), add('butter-naan'), place, add('butter-naan'), place);
    for (const lineId of ['1-butter-naan', '2-butter-naan']) {
      for (let i = 0; i < 3; i++) state = demoReducer(state, { type: 'advance', lineId });
    }
    state = demoReducer(state, { type: 'request', kind: 'request_bill' });
    state = demoReducer(state, { type: 'makeBill' });
    expect(state.billed).toBe(true);
    expect(state.requests).toEqual([]);
    const bill = demoBill(state);
    expect(bill.lines.map((line) => [line.dish.name, line.quantity, line.paise])).toEqual([
      ['Butter Naan', 3, 18000],
    ]);
    expect(bill).toMatchObject({ subtotalPaise: 18000, gstPaise: 900, totalPaise: 18900 });
    expect(state.message).toBe('Bill made for table 5: ₹189.00.');
    // The bill closes ordering.
    expect(demoReducer(state, add('butter-naan'))).toBe(state);
  });

  it('a payment frees the table, and starting again resets everything', () => {
    const billed = demoReducer(served(), { type: 'makeBill' });
    expect(demoReducer(served(), { type: 'pay', mode: 'cash' }).paid).toBeNull();
    const paid = demoReducer(billed, { type: 'pay', mode: 'upi' });
    expect(paid.paid).toBe('upi');
    expect(paid.message).toBe('Paid by UPI. Table 5 is free.');
    expect(demoReducer(paid, { type: 'pay', mode: 'card' })).toBe(paid);

    const again = demoReducer({ ...paid, lang: 'hi' }, { type: 'reset' });
    expect({ ...again, message: '' }).toEqual(INITIAL_DEMO);
  });
});

describe('the next step hint', () => {
  it('starts on the guest phone', () => {
    expect(nextHint(INITIAL_DEMO)).toMatchObject({
      device: 'guest',
      action: { type: 'add', dishId: 'paneer-tikka' },
    });
    expect(nextHint(served())).toMatchObject({ device: 'counter', action: { type: 'makeBill' } });
  });

  it('sends a waiter call to the kitchen first', () => {
    const state = play(add('masala-chai'), place, { type: 'request', kind: 'call_waiter' });
    expect(nextHint(state)).toMatchObject({
      device: 'kitchen',
      action: { type: 'resolve', kind: 'call_waiter' },
    });
  });

  it('leads from any point to a paid table in a few steps', () => {
    const starts = [
      INITIAL_DEMO,
      play(add('paneer-tikka'), add('chicken-65'), add('gulab-jamun')),
      play(add('dal-makhani'), place, { type: 'request', kind: 'call_waiter' }, add('butter-naan')),
      play({ type: 'view', view: 'cart' }),
    ];
    for (const start of starts) {
      let state = start;
      let steps = 0;
      for (let hint = nextHint(state); hint; hint = nextHint(state)) {
        const next = demoReducer(state, hint.action);
        expect(next, hint.text).not.toBe(state); // every hint does something
        state = next;
        expect(++steps).toBeLessThan(25);
      }
      expect(state.paid).toBe('upi');
      expect(state.rounds.flatMap((round) => round.lines).every((l) => l.status === 'served')).toBe(
        true,
      );
    }
  });
});
