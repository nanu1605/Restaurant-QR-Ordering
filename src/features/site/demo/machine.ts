import type { FoodType } from '@/components/shared/food-type-mark';
import { listNames } from '@/features/ordering/format';
import { MAX_LINE_QUANTITY } from '@/features/ordering/limits';
import { STRINGS, type Lang } from '@/features/ordering/strings';
import { formatINR, type Paise } from '@/lib/money';

/**
 * The /demo simulator: one table's order played in the browser, from the
 * guest's phone through the kitchen to the counter. Nothing leaves the page;
 * money is integer paise, as in the app.
 */

export const DEMO_TABLE = '5';

export type DemoCategory = { id: string; name: string; nameHi: string };
export type DemoDish = {
  id: string;
  category: string;
  name: string;
  nameHi: string;
  foodType: FoodType;
  paise: Paise;
};

export const DEMO_CATEGORIES: DemoCategory[] = [
  { id: 'mains', name: 'Starters & mains', nameHi: 'स्टार्टर और मेन कोर्स' },
  { id: 'chai', name: 'Chai & sweets', nameHi: 'चाय और मिठाई' },
];

export const DEMO_MENU: DemoDish[] = [
  {
    id: 'paneer-tikka',
    category: 'mains',
    name: 'Paneer Tikka',
    nameHi: 'पनीर टिक्का',
    foodType: 'veg',
    paise: 28000,
  },
  {
    id: 'chicken-65',
    category: 'mains',
    name: 'Chicken 65',
    nameHi: 'चिकन 65',
    foodType: 'non_veg',
    paise: 32000,
  },
  {
    id: 'dal-makhani',
    category: 'mains',
    name: 'Dal Makhani',
    nameHi: 'दाल मखनी',
    foodType: 'veg',
    paise: 24000,
  },
  {
    id: 'butter-naan',
    category: 'mains',
    name: 'Butter Naan',
    nameHi: 'बटर नान',
    foodType: 'veg',
    paise: 6000,
  },
  {
    id: 'masala-chai',
    category: 'chai',
    name: 'Masala Chai',
    nameHi: 'मसाला चाय',
    foodType: 'veg',
    paise: 4000,
  },
  {
    id: 'gulab-jamun',
    category: 'chai',
    name: 'Gulab Jamun',
    nameHi: 'गुलाब जामुन',
    foodType: 'veg',
    paise: 9000,
  },
];

export function dishById(id: string): DemoDish {
  const dish = DEMO_MENU.find((d) => d.id === id);
  if (!dish) throw new Error(`Unknown demo dish: ${id}`);
  return dish;
}

export function dishName(dish: DemoDish, lang: Lang): string {
  return lang === 'hi' ? dish.nameHi : dish.name;
}

export const DISH_STATUSES = ['placed', 'preparing', 'ready', 'served'] as const;
export type DishStatus = (typeof DISH_STATUSES)[number];
type OpenStatus = Exclude<DishStatus, 'served'>;
type MovedStatus = Exclude<DishStatus, 'placed'>;

const NEXT: Record<OpenStatus, MovedStatus> = {
  placed: 'preparing',
  preparing: 'ready',
  ready: 'served',
};

/** The staff wording: table-drawer's NEXT_LABELS and kitchen-board's TICKET_ACTION. */
export const NEXT_LABELS: Record<OpenStatus, string> = {
  placed: 'Start preparing',
  preparing: 'Mark ready',
  ready: 'Mark served',
};
export const TICKET_ACTION: Record<OpenStatus, string> = {
  placed: 'Start all',
  preparing: 'Mark all ready',
  ready: 'Mark all served',
};

export type GuestView = 'menu' | 'cart' | 'orders';
export type RequestKind = 'call_waiter' | 'request_bill';
export type PaymentMode = 'cash' | 'upi' | 'card';
export const PAYMENT_LABELS: Record<PaymentMode, string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
};

export type DemoLine = { id: string; dishId: string; quantity: number; status: DishStatus };
export type DemoRound = { number: number; at: string; lines: DemoLine[] };

export type DemoState = {
  lang: Lang;
  view: GuestView;
  /** Dish id → quantity; only dishes in the cart. */
  cart: Record<string, number>;
  rounds: DemoRound[];
  requests: RequestKind[];
  billed: boolean;
  paid: PaymentMode | null;
  /** The last event, for the page's one live region. */
  message: string;
};

export type DemoAction =
  | { type: 'lang'; lang: Lang }
  | { type: 'view'; view: GuestView }
  | { type: 'add'; dishId: string }
  | { type: 'remove'; dishId: string }
  /** `at` is the clock time the guest sees on the round ("7:42 pm"). */
  | { type: 'place'; at?: string }
  | { type: 'advance'; lineId: string }
  | { type: 'advanceTicket'; round: number }
  | { type: 'request'; kind: RequestKind }
  | { type: 'resolve'; kind: RequestKind }
  | { type: 'makeBill' }
  | { type: 'pay'; mode: PaymentMode }
  | { type: 'reset' };

export const INITIAL_DEMO: DemoState = {
  lang: 'en',
  view: 'menu',
  cart: {},
  rounds: [],
  requests: [],
  billed: false,
  paid: null,
  message: '',
};

// ─── Derived ─────────────────────────────────────────────────────────────────

export function cartLines(state: DemoState): Array<{ dish: DemoDish; quantity: number }> {
  return DEMO_MENU.filter((dish) => state.cart[dish.id]).map((dish) => ({
    dish,
    quantity: state.cart[dish.id]!,
  }));
}

export function cartCount(state: DemoState): number {
  return cartLines(state).reduce((sum, line) => sum + line.quantity, 0);
}

export function cartTotal(state: DemoState): Paise {
  return cartLines(state).reduce((sum, line) => sum + line.quantity * line.dish.paise, 0);
}

/** The lowest unserved status in a round and how many dishes share it. */
export function ticketStep(round: DemoRound): { status: OpenStatus; lines: DemoLine[] } | null {
  const open = round.lines.filter((line) => line.status !== 'served');
  if (open.length === 0) return null;
  const rank = (status: DishStatus) => DISH_STATUSES.indexOf(status);
  const status = open.reduce(
    (low, line) => (rank(line.status) < rank(low) ? line.status : low),
    open[0]!.status,
  ) as OpenStatus;
  return { status, lines: open.filter((line) => line.status === status) };
}

function allLines(state: DemoState): DemoLine[] {
  return state.rounds.flatMap((round) => round.lines);
}

/** Any time after the first order, as in the app (unserved dishes are billed too). */
export function canMakeBill(state: DemoState): boolean {
  return !state.billed && allLines(state).length > 0;
}

export function allServed(state: DemoState): boolean {
  return allLines(state).every((line) => line.status === 'served');
}

/** One bill line per dish, in menu order. */
export function billLines(
  state: DemoState,
): Array<{ dish: DemoDish; quantity: number; paise: Paise }> {
  return DEMO_MENU.map((dish) => {
    const quantity = allLines(state)
      .filter((line) => line.dishId === dish.id)
      .reduce((sum, line) => sum + line.quantity, 0);
    return { dish, quantity, paise: quantity * dish.paise };
  }).filter((line) => line.quantity > 0);
}

export const GST_PERCENT = 5;

/**
 * The app's bill maths (private.calc_bill_totals): GST at 5% rounded half up
 * to whole paise, split into CGST (the lower half) and SGST, and the total
 * rounded to the rupee.
 */
export function billTotals(subtotalPaise: Paise): {
  subtotalPaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  roundOffPaise: Paise;
  totalPaise: Paise;
} {
  const gstPaise = Math.floor((subtotalPaise * GST_PERCENT + 50) / 100);
  const cgstPaise = Math.floor(gstPaise / 2);
  const preRound = subtotalPaise + gstPaise;
  const totalPaise = Math.round(preRound / 100) * 100;
  return {
    subtotalPaise,
    cgstPaise,
    sgstPaise: gstPaise - cgstPaise,
    roundOffPaise: totalPaise - preRound,
    totalPaise,
  };
}

export function demoBill(state: DemoState) {
  const lines = billLines(state);
  return { lines, ...billTotals(lines.reduce((sum, line) => sum + line.paise, 0)) };
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

const en = STRINGS.en;
const table = en.table(DEMO_TABLE);

const DONE_PHRASE: Record<MovedStatus, [one: string, many: string]> = {
  preparing: ['is being prepared', 'are being prepared'],
  ready: ['is ready', 'are ready'],
  served: ['has been served', 'have been served'],
};

function moved(lines: DemoLine[], status: MovedStatus): string {
  const names = lines.map((line) => dishById(line.dishId).name);
  return `${listNames(names)} ${DONE_PHRASE[status][names.length === 1 ? 0 : 1]}.`;
}

/** Moves the given dishes one step on; a ticket's dishes share one status. */
function advanceLines(state: DemoState, ids: Set<string>): DemoState {
  const changed = allLines(state).filter((line) => ids.has(line.id) && line.status !== 'served');
  if (changed.length === 0) return state;
  const step = (line: DemoLine) => NEXT[line.status as OpenStatus];
  return {
    ...state,
    rounds: state.rounds.map((round) => ({
      ...round,
      lines: round.lines.map((line) =>
        changed.includes(line) ? { ...line, status: step(line) } : line,
      ),
    })),
    message: moved(changed, step(changed[0]!)),
  };
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'lang':
      return {
        ...state,
        lang: action.lang,
        message: `The guest phone is now in ${action.lang === 'hi' ? 'Hindi' : 'English'}.`,
      };
    case 'view':
      if (action.view === 'orders' && state.rounds.length === 0) return state;
      if (action.view !== 'orders' && state.billed) return state;
      return { ...state, view: action.view };
    case 'add': {
      const dish = dishById(action.dishId);
      const quantity = (state.cart[dish.id] ?? 0) + 1;
      if (state.billed || quantity > MAX_LINE_QUANTITY) return state;
      return {
        ...state,
        cart: { ...state.cart, [dish.id]: quantity },
        message: en.menu.added(dish.name, quantity),
      };
    }
    case 'remove': {
      const dish = dishById(action.dishId);
      const quantity = (state.cart[dish.id] ?? 0) - 1;
      if (quantity < 0) return state;
      const cart = { ...state.cart, [dish.id]: quantity };
      if (quantity === 0) delete cart[dish.id];
      return {
        ...state,
        cart,
        message:
          quantity === 0 ? en.menu.removed(dish.name) : en.menu.inCartOf(dish.name, quantity),
      };
    }
    case 'place': {
      const lines = cartLines(state);
      if (lines.length === 0 || state.billed) return state;
      const number = state.rounds.length + 1;
      return {
        ...state,
        cart: {},
        view: 'orders',
        rounds: [
          ...state.rounds,
          {
            number,
            at: action.at ?? '',
            lines: lines.map(({ dish, quantity }) => ({
              id: `${number}-${dish.id}`,
              dishId: dish.id,
              quantity,
              status: 'placed',
            })),
          },
        ],
        message: 'Order sent to the kitchen.',
      };
    }
    case 'advance':
      return advanceLines(state, new Set([action.lineId]));
    case 'advanceTicket': {
      const round = state.rounds.find((r) => r.number === action.round);
      const step = round && ticketStep(round);
      return step ? advanceLines(state, new Set(step.lines.map((line) => line.id))) : state;
    }
    case 'request': {
      const refused =
        state.rounds.length === 0 ||
        state.paid !== null ||
        state.requests.includes(action.kind) ||
        (action.kind === 'request_bill' && state.billed);
      if (refused) return state;
      return {
        ...state,
        requests: [...state.requests, action.kind],
        message:
          action.kind === 'call_waiter'
            ? `${table} is calling a waiter.`
            : `${table} asked for the bill.`,
      };
    }
    case 'resolve':
      if (!state.requests.includes(action.kind)) return state;
      return {
        ...state,
        requests: state.requests.filter((kind) => kind !== action.kind),
        message: action.kind === 'call_waiter' ? 'Waiter call done.' : 'Bill request done.',
      };
    case 'makeBill': {
      if (!canMakeBill(state)) return state;
      // The bill closes the table's ordering, as in the app.
      const billed = { ...state, billed: true, view: 'orders' as const, cart: {} };
      return {
        ...billed,
        requests: state.requests.filter((kind) => kind !== 'request_bill'),
        message: `Bill made for ${table.toLowerCase()}: ${formatINR(demoBill(billed).totalPaise)}.`,
      };
    }
    case 'pay':
      if (!state.billed || state.paid) return state;
      return {
        ...state,
        paid: action.mode,
        requests: [],
        message: `Paid by ${PAYMENT_LABELS[action.mode]}. ${table} is free.`,
      };
    case 'reset':
      return { ...INITIAL_DEMO, message: 'The demo has started again.' };
  }
}

// ─── What to try next ────────────────────────────────────────────────────────

export type DemoDevice = 'guest' | 'kitchen' | 'counter';
export type DemoHint = { device: DemoDevice; text: string; action: DemoAction };

/** The kitchen's next button for the oldest unfinished round. */
export function kitchenHint(state: DemoState): DemoHint | null {
  for (const round of state.rounds) {
    const step = ticketStep(round);
    if (!step) continue;
    const ticket = step.lines.length > 1;
    const label = ticket ? TICKET_ACTION[step.status] : NEXT_LABELS[step.status];
    return {
      device: 'kitchen',
      text: `On the kitchen tablet, tap “${label}”.`,
      action: ticket
        ? { type: 'advanceTicket', round: round.number }
        : { type: 'advance', lineId: step.lines[0]!.id },
    };
  }
  return null;
}

/** Which device and button the visitor should try next; null once paid. */
export function nextHint(state: DemoState): DemoHint | null {
  if (state.paid) return null;
  // Calls reach the waiters' board and the admin's live orders, not the kitchen view.
  if (state.requests.includes('call_waiter')) {
    return {
      device: 'counter',
      text: 'The guest is calling. On the counter laptop, tap “Done”.',
      action: { type: 'resolve', kind: 'call_waiter' },
    };
  }
  if (state.billed) {
    return {
      device: 'counter',
      text: 'On the counter laptop, record the payment: Cash, UPI or Card.',
      action: { type: 'pay', mode: 'upi' },
    };
  }
  if (cartCount(state) > 0) {
    return state.view === 'cart'
      ? { device: 'guest', text: 'On the guest phone, place the order.', action: { type: 'place' } }
      : {
          device: 'guest',
          text: 'On the guest phone, open the cart.',
          action: { type: 'view', view: 'cart' },
        };
  }
  const kitchen = kitchenHint(state);
  if (kitchen) return kitchen;
  if (state.rounds.length === 0) {
    return state.view === 'menu'
      ? {
          device: 'guest',
          text: 'On the guest phone, add a dish or two.',
          action: { type: 'add', dishId: DEMO_MENU[0]!.id },
        }
      : {
          device: 'guest',
          text: 'On the guest phone, go back to the menu.',
          action: { type: 'view', view: 'menu' },
        };
  }
  return {
    device: 'counter',
    text: 'Every dish is served. On the counter laptop, tap “Make bill”.',
    action: { type: 'makeBill' },
  };
}
