import type { FoodType } from '@/components/shared/food-type-mark';
import { listNames } from '@/features/ordering/format';
import { MAX_LINE_QUANTITY } from '@/features/ordering/limits';
import { STRINGS, type Lang } from '@/features/ordering/strings';
import { formatINR, type Paise } from '@/lib/money';

import type { SiteLang } from '../content';

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

export type GuestView = 'menu' | 'cart' | 'orders';
export type RequestKind = 'call_waiter' | 'request_bill';
export type PaymentMode = 'cash' | 'upi' | 'card';
export type DemoDevice = 'guest' | 'kitchen' | 'counter';

/**
 * The staff buttons the kitchen tablet and counter laptop show, and the hints quote:
 * table-drawer's NEXT_LABELS, kitchen-board's TICKET_ACTION, the bill's payment modes,
 * "Done" and "Make bill". English on every site, as in the app (docs/DECISIONS.md W-15),
 * so they sit outside the per-language words.
 */
export const STAFF_WORDS = {
  nextLabels: {
    placed: 'Start preparing',
    preparing: 'Mark ready',
    ready: 'Mark served',
  } satisfies Record<OpenStatus, string>,
  ticketAction: {
    placed: 'Start all',
    preparing: 'Mark all ready',
    ready: 'Mark all served',
  } satisfies Record<OpenStatus, string>,
  payment: { cash: 'Cash', upi: 'UPI', card: 'Card' } satisfies Record<PaymentMode, string>,
  done: 'Done',
  makeBill: 'Make bill',
};

/**
 * The demo's own words by website language: what the page says around the
 * three devices and in its live region. The guest phone speaks STRINGS in its
 * own language; the staff screens' words are STAFF_WORDS.
 */
const en = {
  /** The simulator's controls. */
  nextStep: 'Next step:',
  allDone: 'All done. The bill is paid and the table is free. Start again to play once more.',
  showMe: 'Show me',
  stop: 'Stop',
  startAgain: 'Start again',
  devicesGroup: 'Device to show',
  tryNext: '(try this next)',
  /** Each device's button below lg, and its heading. */
  devices: {
    guest: { label: 'Guest phone', title: 'Guest phone' },
    kitchen: { label: 'Kitchen', title: 'Kitchen tablet' },
    counter: { label: 'Counter', title: 'Counter laptop' },
  } satisfies Record<DemoDevice, { label: string; title: string }>,
  /** The live region; `table` is STRINGS' "Table 5" in the site's language. */
  says: {
    phoneLang: (lang: Lang) => `The guest phone is now in ${lang === 'hi' ? 'Hindi' : 'English'}.`,
    placed: 'Order sent to the kitchen.',
    /** A kitchen step, for one dish or more: "Paneer Tikka and Chicken 65 are ready." */
    moved: {
      preparing: (names: string[]) =>
        `${listNames(names)} ${names.length === 1 ? 'is' : 'are'} being prepared.`,
      ready: (names: string[]) => `${listNames(names)} ${names.length === 1 ? 'is' : 'are'} ready.`,
      served: (names: string[]) =>
        `${listNames(names)} ${names.length === 1 ? 'has' : 'have'} been served.`,
    } satisfies Record<MovedStatus, (names: string[]) => string>,
    request: {
      call_waiter: (table: string) => `${table} is calling a waiter.`,
      request_bill: (table: string) => `${table} asked for the bill.`,
    } satisfies Record<RequestKind, (table: string) => string>,
    resolved: {
      call_waiter: 'Waiter call done.',
      request_bill: 'Bill request done.',
    } satisfies Record<RequestKind, string>,
    billMade: (table: string, total: string) => `Bill made for ${table.toLowerCase()}: ${total}.`,
    paid: (mode: string, table: string) => `Paid by ${mode}. ${table} is free.`,
    reset: 'The demo has started again.',
  },
  /** What to try next, on which device. */
  hints: {
    kitchen: (label: string) => `On the kitchen tablet, tap “${label}”.`,
    calling: (done: string) => `The guest is calling. On the counter laptop, tap “${done}”.`,
    pay: ({ cash, upi, card }: Record<PaymentMode, string>) =>
      `On the counter laptop, record the payment: ${cash}, ${upi} or ${card}.`,
    place: 'On the guest phone, place the order.',
    openCart: 'On the guest phone, open the cart.',
    add: 'On the guest phone, add a dish or two.',
    backToMenu: 'On the guest phone, go back to the menu.',
    makeBill: (label: string) => `Every dish is served. On the counter laptop, tap “${label}”.`,
  },
};

export type DemoWords = typeof en;

/** Hindi: dish names and "टेबल 5" come from STRINGS.hi; the hints quote the English staff buttons. */
const hi: DemoWords = {
  nextStep: 'अगला कदम:',
  allDone:
    'सब हो गया। बिल का भुगतान हो गया और टेबल ख़ाली है। दोबारा चलाने के लिए फिर से शुरू करें।',
  showMe: 'दिखाएँ',
  stop: 'रोकें',
  startAgain: 'फिर से शुरू करें',
  devicesGroup: 'कौन-सा डिवाइस दिखाएँ',
  tryNext: '(अब इसे आज़माएँ)',
  devices: {
    guest: { label: 'ग्राहक का फ़ोन', title: 'ग्राहक का फ़ोन' },
    kitchen: { label: 'किचन', title: 'किचन टैबलेट' },
    counter: { label: 'काउंटर', title: 'काउंटर लैपटॉप' },
  },
  says: {
    phoneLang: (lang) => `ग्राहक का फ़ोन अब ${lang === 'hi' ? 'हिन्दी' : 'अंग्रेज़ी'} में है।`,
    placed: 'ऑर्डर किचन को भेज दिया गया।',
    // Worded so the verb doesn't take each dish name's gender.
    moved: {
      preparing: (names) => `किचन में ${listNames(names, 'और')} की तैयारी शुरू हो गई।`,
      ready: (names) => `${listNames(names, 'और')} तैयार ${names.length === 1 ? 'है' : 'हैं'}।`,
      served: (names) =>
        `${listNames(names, 'और')} अब टेबल पर ${names.length === 1 ? 'है' : 'हैं'}।`,
    },
    request: {
      call_waiter: (table) => `${table} ने वेटर को बुलाया है।`,
      request_bill: (table) => `${table} ने बिल माँगा है।`,
    },
    resolved: {
      call_waiter: 'वेटर की कॉल पूरी हुई।',
      request_bill: 'बिल की माँग पूरी हुई।',
    },
    billMade: (table, total) => `${table} का बिल बन गया: ${total}।`,
    paid: (mode, table) => `${mode} से भुगतान हो गया। ${table} अब ख़ाली है।`,
    reset: 'डेमो फिर से शुरू हो गया है।',
  },
  hints: {
    kitchen: (label) => `किचन टैबलेट पर “${label}” दबाएँ।`,
    calling: (done) => `ग्राहक वेटर को बुला रहे हैं। काउंटर लैपटॉप पर “${done}” दबाएँ।`,
    pay: ({ cash, upi, card }) => `काउंटर लैपटॉप पर भुगतान दर्ज करें: ${cash}, ${upi} या ${card}।`,
    place: 'ग्राहक के फ़ोन पर ऑर्डर करें।',
    openCart: 'ग्राहक के फ़ोन पर कार्ट खोलें।',
    add: 'ग्राहक के फ़ोन पर एक-दो डिश जोड़ें।',
    backToMenu: 'ग्राहक के फ़ोन पर मेन्यू पर वापस जाएँ।',
    makeBill: (label) => `सारी डिश परोसी जा चुकी हैं। काउंटर लैपटॉप पर “${label}” दबाएँ।`,
  },
};

export const DEMO_WORDS: Record<SiteLang, DemoWords> = { en, hi };

export type DemoLine = { id: string; dishId: string; quantity: number; status: DishStatus };
export type DemoRound = { number: number; at: string; lines: DemoLine[] };

export type DemoState = {
  /** The website's language: the demo's words and the phone's first language. */
  site: SiteLang;
  /** The guest phone's language, which its switch changes. */
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

export function initialDemo(site: SiteLang): DemoState {
  return {
    site,
    lang: site,
    view: 'menu',
    cart: {},
    rounds: [],
    requests: [],
    billed: false,
    paid: null,
    message: '',
  };
}

export const INITIAL_DEMO = initialDemo('en');

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

/** Moves the given dishes one step on; a ticket's dishes share one status. */
function advanceLines(state: DemoState, ids: Set<string>): DemoState {
  const changed = allLines(state).filter((line) => ids.has(line.id) && line.status !== 'served');
  if (changed.length === 0) return state;
  const step = (line: DemoLine) => NEXT[line.status as OpenStatus];
  const names = changed.map((line) => dishName(dishById(line.dishId), state.site));
  return {
    ...state,
    rounds: state.rounds.map((round) => ({
      ...round,
      lines: round.lines.map((line) =>
        changed.includes(line) ? { ...line, status: step(line) } : line,
      ),
    })),
    message: DEMO_WORDS[state.site].says.moved[step(changed[0]!)](names),
  };
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  const t = STRINGS[state.site];
  const says = DEMO_WORDS[state.site].says;
  const table = t.table(DEMO_TABLE);
  switch (action.type) {
    case 'lang':
      return { ...state, lang: action.lang, message: says.phoneLang(action.lang) };
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
        message: t.menu.added(dishName(dish, state.site), quantity),
      };
    }
    case 'remove': {
      const dish = dishById(action.dishId);
      const quantity = (state.cart[dish.id] ?? 0) - 1;
      if (quantity < 0) return state;
      const cart = { ...state.cart, [dish.id]: quantity };
      if (quantity === 0) delete cart[dish.id];
      const name = dishName(dish, state.site);
      return {
        ...state,
        cart,
        message: quantity === 0 ? t.menu.removed(name) : t.menu.inCartOf(name, quantity),
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
        message: says.placed,
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
        message: says.request[action.kind](table),
      };
    }
    case 'resolve':
      if (!state.requests.includes(action.kind)) return state;
      return {
        ...state,
        requests: state.requests.filter((kind) => kind !== action.kind),
        message: says.resolved[action.kind],
      };
    case 'makeBill': {
      if (!canMakeBill(state)) return state;
      // The bill closes the table's ordering, as in the app.
      const billed = { ...state, billed: true, view: 'orders' as const, cart: {} };
      return {
        ...billed,
        requests: state.requests.filter((kind) => kind !== 'request_bill'),
        message: says.billMade(table, formatINR(demoBill(billed).totalPaise)),
      };
    }
    case 'pay':
      if (!state.billed || state.paid) return state;
      return {
        ...state,
        paid: action.mode,
        requests: [],
        message: says.paid(STAFF_WORDS.payment[action.mode], table),
      };
    case 'reset':
      return { ...initialDemo(state.site), message: says.reset };
  }
}

// ─── What to try next ────────────────────────────────────────────────────────

export type DemoHint = { device: DemoDevice; text: string; action: DemoAction };

/** The kitchen's next button for the oldest unfinished round. */
export function kitchenHint(state: DemoState): DemoHint | null {
  const { hints } = DEMO_WORDS[state.site];
  for (const round of state.rounds) {
    const step = ticketStep(round);
    if (!step) continue;
    const ticket = step.lines.length > 1;
    const label = ticket
      ? STAFF_WORDS.ticketAction[step.status]
      : STAFF_WORDS.nextLabels[step.status];
    return {
      device: 'kitchen',
      text: hints.kitchen(label),
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
  const { hints } = DEMO_WORDS[state.site];
  // Calls reach the waiters' board and the admin's live orders, not the kitchen view.
  if (state.requests.includes('call_waiter')) {
    return {
      device: 'counter',
      text: hints.calling(STAFF_WORDS.done),
      action: { type: 'resolve', kind: 'call_waiter' },
    };
  }
  if (state.billed) {
    return {
      device: 'counter',
      text: hints.pay(STAFF_WORDS.payment),
      action: { type: 'pay', mode: 'upi' },
    };
  }
  if (cartCount(state) > 0) {
    return state.view === 'cart'
      ? { device: 'guest', text: hints.place, action: { type: 'place' } }
      : {
          device: 'guest',
          text: hints.openCart,
          action: { type: 'view', view: 'cart' },
        };
  }
  const kitchen = kitchenHint(state);
  if (kitchen) return kitchen;
  if (state.rounds.length === 0) {
    return state.view === 'menu'
      ? {
          device: 'guest',
          text: hints.add,
          action: { type: 'add', dishId: DEMO_MENU[0]!.id },
        }
      : {
          device: 'guest',
          text: hints.backToMenu,
          action: { type: 'view', view: 'menu' },
        };
  }
  return {
    device: 'counter',
    text: hints.makeBill(STAFF_WORDS.makeBill),
    action: { type: 'makeBill' },
  };
}
