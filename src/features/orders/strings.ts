import { ROLE_LABELS } from '@/lib/auth/roles';
import { ORDER_ITEM_STATUS_LABELS } from '@/lib/order-status';
import { listNames, tableHeading } from '@/features/ordering/format';
import { STRINGS, type Lang } from '@/features/ordering/strings';
import { THEME_LABELS } from '@/features/theme/theme';

import { FILTER_LABELS, TABLE_STATE_LABELS, formatElapsed } from './board-view';
import type { REJECT_REASONS, REMOVE_REASONS } from './schemas';

/**
 * The worker panel's words in English and Hindi (docs/DECISIONS.md P11-15 to
 * P11-18). Hindi has every English key (the compiler checks). Only /staff
 * switches language: /admin/live reuses these screens and stays English, so
 * words that only show there (Delete order, Revert, waiter assignment) stay in
 * their components. Names stay as the restaurant entered them, except dishes
 * and categories with a Hindi name; money and times stay in the en-IN format.
 */

/** A refused action as the server sent it: English text, and its code when it has one. */
export type Refusal = { error: string; code?: string; detail?: string };

const en = {
  panel: 'Worker panel',
  adminPanel: 'Admin panel',
  roles: ROLE_LABELS,
  and: 'and',
  close: 'Close',
  loading: 'Loading…',
  tryAgain: 'Try again',
  table: tableHeading,
  /** Read before a bare table number ("Table 5"); named tables need none. */
  tablePrefix: 'Table ',
  elapsed: formatElapsed,
  /** The account menu's own words; the role and panel names are above. */
  account: {
    install: 'Install app',
    installSafari:
      'To install, tap Share (under ••• if you don’t see it), then Add to Home Screen.',
    logOut: 'Log out',
    theme: THEME_LABELS,
    language: 'Language',
  },
  live: {
    connection: { live: 'Live', reconnecting: 'Reconnecting…', offline: 'Offline' },
    enableSound: 'Enable sound',
    sound: 'New order sound',
    soundOn: 'New order sound is on',
    soundOff: 'New order sound is off',
  },
  nav: {
    label: 'Worker panel sections',
    board: 'Board',
    kitchen: 'Kitchen',
    availability: 'Availability',
  },
  kitchenNotInPlan: {
    title: 'The kitchen view isn’t in your plan',
    description: (plan: string) => `Available on ${plan}. The board still shows every order.`,
  },
  network: 'Couldn’t reach the server. Check the connection and try again.',
  generic: 'Something went wrong. Try again.',
  /** The server's English, as it is; Hindi words it by its code. */
  refusal: (refusal: Refusal) => refusal.error,
  tableState: TABLE_STATE_LABELS,
  filters: FILTER_LABELS,
  status: ORDER_ITEM_STATUS_LABELS,
  foodType: STRINGS.en.foodType,
  /** Dishes by status on a table card: "3 New". */
  counts: {
    placed: ORDER_ITEM_STATUS_LABELS.placed,
    preparing: ORDER_ITEM_STATUS_LABELS.preparing,
    ready: ORDER_ITEM_STATUS_LABELS.ready,
    served: ORDER_ITEM_STATUS_LABELS.served,
  },
  requests: {
    call_waiter: { badge: 'Calling', line: 'Calling a waiter' },
    request_bill: { badge: 'Bill requested', line: 'Asked for the bill' },
    acknowledgedBadge: ' (acknowledged)',
    section: 'Customer requests',
    ago: (time: string) => `${time} ago`,
    acknowledgedNote: ' · acknowledged',
    acknowledge: 'Acknowledge',
    done: 'Done',
  },
  board: {
    label: 'Tables',
    filtersLabel: 'Show tables',
    loading: 'Loading tables…',
    noTables: 'No tables yet',
    noTablesHint: 'Ask a manager to add tables in the admin panel.',
    noneInFilter: (filter: string) => `No tables in “${filter}”`,
    chooseAll: 'Choose All to see every table.',
  },
  card: { unassigned: 'Unassigned', seatedFor: 'Seated for' },
  drawer: {
    seatedAgo: (time: string) => `Seated ${time} ago`,
    free: 'Free — no one is seated here.',
    waiter: 'Waiter:',
    unassigned: 'Unassigned',
    waitingElsewhere: (count: number) =>
      count === 1
        ? 'An order is waiting for a waiter to approve. It shows here once approved.'
        : `${count} orders are waiting for a waiter to approve. They show here once approved.`,
    waitingRound: (round: number) => `Round ${round}, waiting for approval`,
    waitingForApproval: 'Waiting for approval',
    note: (note: string) => `Note: ${note}`,
    approve: 'Approve',
    reject: 'Reject',
    /** Read after a button's visible words. */
    roundSuffix: (round: number) => ` round ${round}`,
    inRound: (round: number) => ` in round ${round}`,
    openToOrder: 'Add an order to open this table. It stays open until the bill is generated.',
    paused: 'New orders are paused while the restaurant is read-only.',
    pausedServe:
      'New orders are paused while the restaurant is read-only. Dishes already ordered can still be served.',
    addDishes: 'Add dishes',
    addOrder: 'Add order',
    moveTable: 'Move table',
    closeWithoutBill: 'Close without bill',
    approved: 'Order approved',
    rejectTitle: (round: number) => `Reject round ${round}`,
    rejectDescription:
      'The customer sees the reason. The table’s next order waits for approval again.',
    rejectConfirm: 'Reject order',
    rejected: 'Order rejected',
    closeTitle: (heading: string) => `Close ${heading} without a bill`,
    closeOnTheWay: (count: number) =>
      `${count} ${count === 1 ? 'dish' : 'dishes'} still on the way will be cancelled; served dishes stay on record. The table becomes free.`,
    closeEmpty: 'The table becomes free for the next guests.',
    closeConfirm: 'Close table',
    closed: (heading: string) => `${heading} closed`,
    round: (round: number) => `Round ${round}`,
    addedByStaff: 'Added by staff',
    customer: 'Customer',
    roundRejected: 'Rejected',
    roundDeleted: 'Deleted',
    roundCancelled: 'Cancelled by the customer',
    rejectedReason: (reason: string) => `Rejected: ${reason}`,
    deletedBy: (name: string | null, reason: string) =>
      `Deleted${name ? ` by ${name}` : ''}: ${reason}`,
    removedBy: (name: string | null, reason: string | null) =>
      `Removed${name ? ` by ${name}` : ''}${reason ? `: ${reason}` : ''}`,
    markAllServed: 'Mark all served',
    next: { preparing: 'Start preparing', ready: 'Mark ready', served: 'Mark served' },
    remove: 'Remove',
    askManager: 'Ask manager to remove',
  },
  add: {
    tooMany: 'One round can have up to 30 different dishes. Place this one, then add the rest.',
    unavailable: (names: string[]) => {
      const one = names.length === 1;
      return `${listNames(names)} ${one ? 'is' : 'are'} out of stock or off the menu, so ${
        one ? 'it was' : 'they were'
      } taken out.`;
    },
    placedFirst: (heading: string) => `Order placed for ${heading}`,
    placedRound: (round: number, heading: string) =>
      `Round ${round} sent to the kitchen · ${heading}`,
    nowYours: 'You’re now the waiter for this table.',
    toSession: 'Goes to the kitchen as a new round.',
    toNewSession: 'Opens the table; the order goes straight to the kitchen.',
    changed: (heading: string, wasOpen: boolean) =>
      wasOpen
        ? `${heading} was closed or billed meanwhile. Placing this order opens it again.`
        : `${heading} was opened by someone else meanwhile. This order joins it.`,
    search: 'Search dishes',
    loadingMenu: 'Loading the menu…',
    menuFailed: 'The menu couldn’t be loaded.',
    noMatch: (query: string) => `No dishes match “${query}”.`,
    emptyMenu: 'The menu has no dishes yet.',
    thisRound: 'This round',
    noteFor: (name: string) => `Note for ${name}`,
    notePlaceholder: 'Note for the kitchen (optional)',
    roundNote: 'Note for the whole round',
    roundNotePlaceholder: 'Note for the whole round (optional)',
    noDishes: 'No dishes yet',
    items: (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`,
    placing: 'Placing…',
    place: 'Place order',
    addToRound: 'Add to round',
    outOfStock: 'Out of stock',
    choose: 'Choose',
    /** Read after an option's price. */
    addName: (name: string) => ` · add ${name}`,
    add: 'Add',
  },
  kitchen: {
    loading: 'Loading orders…',
    columns: { placed: 'New', preparing: 'Preparing', ready: 'Ready' },
    empty: {
      placed: 'No new orders',
      preparing: 'Nothing being prepared',
      ready: 'Nothing waiting to be served',
    },
    action: { placed: 'Start all', preparing: 'Mark all ready', ready: 'Mark all served' },
    /** Read after a dish, saying what a tap does. */
    itemAction: { preparing: 'start preparing', ready: 'mark ready', served: 'mark served' },
    served: (names: string) => `${names} served`,
    movedTo: (names: string, column: string) => `${names} moved to ${column}`,
    goTo: 'Go to column',
    ticket: (heading: string, round: number) => `${heading}, round ${round}`,
    round: (round: number) => `· Round ${round}`,
    late: 'Late · ',
    forTicket: (ticket: string) => ` for ${ticket}`,
  },
  stock: {
    title: 'Availability',
    intro:
      'Switch a dish or add-on off when it runs out. Customers see it as not available straight away.',
    back: (name: string) => `${name} is back in stock`,
    out: (name: string) => `${name} is out of stock`,
    empty: 'No dishes on the menu yet',
    emptyHint: 'A manager can add dishes in the admin panel.',
    noMatch: (query: string) => `No dishes match “${query}”.`,
    addons: (group: string) => `Add-ons · ${group}`,
    inStock: 'In stock',
    outOfStock: 'Out of stock',
    switchLabel: (name: string) => `${name} in stock`,
  },
  alerts: {
    needsApproval: (table: string) => `${table} needs approval`,
    newOrder: (table: string) => `New order · ${table}`,
    round: (round: number) => `Round ${round}`,
    calling: (table: string) => `${table} is calling a waiter`,
    bill: (table: string) => `${table} asked for the bill`,
  },
  move: {
    moved: (heading: string) => `Moved to ${heading}`,
    scan: (heading: string) => `Ask the guests to scan the QR code on ${heading}.`,
    title: (heading: string) => `Move ${heading}`,
    description: 'Choose a free table. The orders, waiter and bill move with the guests.',
    none: 'Every other table has guests right now.',
    freeTables: 'Free tables',
  },
  offline: {
    kept: (count: number) => `${count} ${count === 1 ? 'change' : 'changes'} kept on this device`,
    offlineKept: (kept: string) =>
      `Offline. ${kept}, sent when you’re back online. Other actions need a connection.`,
    offline:
      'Offline. Dish status changes are kept on this device and sent when you’re back online. Other actions need a connection.',
    unreachable: (kept: string) => `Can’t reach the server. ${kept}, sent as soon as it answers.`,
  },
  reason: {
    required: 'Choose or type a reason.',
    legend: 'Reason',
    other: 'Other…',
    otherLabel: 'Other reason',
    cancel: 'Cancel',
    /** A preset's words; what is saved (and shown to guests) stays English. */
    text: (reason: string) => reason,
  },
  remove: {
    title: (name: string) => `Remove ${name}`,
    keeps: (left: number, name: string) =>
      `The order keeps ${left} × ${name}. Your reason is recorded.`,
    struck: 'The dish stays on the order, struck through with your reason.',
    confirmSome: (count: number) => `Remove ${count}`,
    confirmAll: 'Remove dish',
    removedSome: (count: number, name: string) => `Removed ${count} × ${name}`,
    removed: (name: string) => `Removed ${name}`,
    howMany: 'How many to remove',
    of: (count: number) => `of ${count}`,
    stepper: STRINGS.en.stepper,
  },
};

export type StaffStrings = typeof en;

const hiTable = STRINGS.hi.table;

/** The preset reasons in Hindi, by the English that is saved. */
const HI_REASONS: Record<
  (typeof REJECT_REASONS)[number] | (typeof REMOVE_REASONS)[number],
  string
> = {
  'Prank / not seated': 'मज़ाक / कोई बैठा नहीं',
  'Items unavailable': 'डिश उपलब्ध नहीं',
  Duplicate: 'दोबारा आया ऑर्डर',
  'Customer request': 'ग्राहक ने कहा',
  'Wrong item': 'ग़लत डिश',
  'Out of stock': 'स्टॉक में नहीं',
  'Quality complaint': 'क्वालिटी की शिकायत',
};

type Message = string | ((detail: string) => string);

/**
 * The database's refusals a worker panel action can meet, in Hindi (their
 * English is in lib/db-errors.ts). Any other refusal gets the generic message.
 */
export const HI_REFUSALS: Record<string, Message> = {
  FORBIDDEN: 'आपको यह करने की अनुमति नहीं है।',
  NOT_FOUND: 'यह अब मौजूद नहीं है। पेज रीफ़्रेश करके फिर से कोशिश करें।',
  INVALID_INPUT: 'कुछ जानकारी सही नहीं है। जाँचकर फिर से कोशिश करें।',
  RESTAURANT_READ_ONLY:
    'सब्सक्रिप्शन बंद रहने तक बदलाव रुके हुए हैं। सर्विस के काम अब भी चलते हैं।',
  SESSION_NOT_OPEN: 'इस बीच इस टेबल का बिल बन गया या यह बंद हो गई। बोर्ड अब अपडेट है।',
  ORDER_NOT_PENDING: 'किसी ने यह ऑर्डर पहले ही मंज़ूर या मना कर दिया है।',
  ORDER_NOT_ACCEPTED:
    'यह ऑर्डर बदला नहीं जा सकता: यह मंज़ूरी का इंतज़ार कर रहा है, मना हो चुका है या हटाया जा चुका है।',
  ORDER_NOT_ACTIVE: 'यह ऑर्डर पहले ही मना किया या हटाया जा चुका है।',
  ITEM_NOT_ACTIVE: 'यह डिश पहले ही रद्द की या हटाई जा चुकी है।',
  INVALID_STATUS_CHANGE: 'यह डिश पहले ही आगे बढ़ चुकी है। बोर्ड अब अपडेट है।',
  REQUIRES_MANAGER:
    'मैनेजर से कहें: परोसी गई डिश हटाना या ऑर्डर वाली टेबल बंद करना सिर्फ़ मैनेजर कर सकते हैं।',
  REASON_REQUIRED: 'कोई कारण चुनें या लिखें।',
  ORDERING_UNAVAILABLE:
    'सब्सक्रिप्शन बंद रहने तक नए ऑर्डर रुके हुए हैं। खुली टेबल को अब भी परोसा जा सकता है।',
  ITEM_UNAVAILABLE: 'कुछ डिश स्टॉक में नहीं हैं या मेन्यू से हट गई हैं। हमने उन्हें हटा दिया है।',
  TABLE_BUSY: (label) =>
    `${label ? hiTable(label) : 'उस टेबल'} पर अभी मेहमान हैं। कोई दूसरी टेबल चुनें।`,
};

const HI_GENERIC = 'कुछ गड़बड़ हो गई। फिर से कोशिश करें।';

const hi: StaffStrings = {
  panel: 'वर्कर पैनल',
  adminPanel: 'एडमिन पैनल',
  roles: { owner: 'मालिक', manager: 'मैनेजर', waiter: 'वेटर', kitchen: 'किचन' },
  and: 'और',
  close: 'बंद करें',
  loading: 'लोड हो रहा है…',
  tryAgain: 'फिर से कोशिश करें',
  table: hiTable,
  tablePrefix: 'टेबल ',
  elapsed: (minutes) =>
    minutes < 60
      ? `${minutes} मिनट`
      : `${Math.floor(minutes / 60)} घं ${String(minutes % 60).padStart(2, '0')} मिनट`,
  account: {
    install: 'ऐप इंस्टॉल करें',
    installSafari:
      'इंस्टॉल करने के लिए Share दबाएँ (न दिखे तो ••• में), फिर Add to Home Screen चुनें।',
    logOut: 'लॉग आउट',
    theme: STRINGS.hi.theme,
    language: 'भाषा',
  },
  live: {
    connection: { live: 'लाइव', reconnecting: 'फिर से जुड़ रहा है…', offline: 'ऑफ़लाइन' },
    enableSound: 'आवाज़ चालू करें',
    sound: 'नए ऑर्डर की आवाज़',
    soundOn: 'नए ऑर्डर की आवाज़ चालू है',
    soundOff: 'नए ऑर्डर की आवाज़ बंद है',
  },
  nav: {
    label: 'वर्कर पैनल के हिस्से',
    board: 'बोर्ड',
    kitchen: 'किचन',
    availability: 'उपलब्धता',
  },
  kitchenNotInPlan: {
    title: 'किचन व्यू आपके प्लान में नहीं है',
    description: (plan) => `${plan} प्लान में उपलब्ध। बोर्ड पर फिर भी हर ऑर्डर दिखता है।`,
  },
  network: 'सर्वर से संपर्क नहीं हो पाया। कनेक्शन जाँचें और फिर से कोशिश करें।',
  generic: HI_GENERIC,
  refusal: ({ code, detail }) => {
    const message =
      code !== undefined && Object.hasOwn(HI_REFUSALS, code) ? HI_REFUSALS[code] : null;
    if (!message) return HI_GENERIC;
    return typeof message === 'function' ? message(detail?.trim() ?? '') : message;
  },
  tableState: {
    needs_approval: 'मंज़ूरी बाक़ी',
    in_progress: 'चल रहा है',
    all_served: 'सब परोसा गया',
    idle: 'कोई डिश बाक़ी नहीं',
    free: 'खाली',
  },
  filters: {
    all: 'सभी',
    mine: 'मेरी टेबल',
    needs_approval: 'मंज़ूरी बाक़ी',
    unassigned: 'बिना वेटर',
    in_progress: 'चल रहा है',
    all_served: 'सब परोसा गया',
  },
  status: {
    placed: 'नया',
    preparing: 'बन रहा है',
    ready: 'तैयार',
    served: 'परोसा गया',
    cancelled: 'रद्द',
    removed: 'हटाया गया',
  },
  foodType: STRINGS.hi.foodType,
  counts: { placed: 'नए', preparing: 'बन रहे', ready: 'तैयार', served: 'परोसे गए' },
  requests: {
    call_waiter: { badge: 'बुला रहे हैं', line: 'वेटर को बुला रहे हैं' },
    request_bill: { badge: 'बिल माँगा', line: 'बिल माँगा है' },
    acknowledgedBadge: ' (देख लिया)',
    section: 'ग्राहकों के अनुरोध',
    ago: (time) => `${time} पहले`,
    acknowledgedNote: ' · देख लिया',
    acknowledge: 'देख लिया',
    done: 'हो गया',
  },
  board: {
    label: 'टेबल',
    filtersLabel: 'टेबल दिखाएँ',
    loading: 'टेबल लोड हो रही हैं…',
    noTables: 'अभी कोई टेबल नहीं',
    noTablesHint: 'मैनेजर से एडमिन पैनल में टेबल जोड़ने को कहें।',
    noneInFilter: (filter) => `“${filter}” में कोई टेबल नहीं`,
    chooseAll: 'सभी टेबल देखने के लिए “सभी” चुनें।',
  },
  card: { unassigned: 'बिना वेटर', seatedFor: 'बैठे हुए' },
  drawer: {
    seatedAgo: (time) => `${time} से बैठे हैं`,
    free: 'खाली — यहाँ कोई नहीं बैठा है।',
    waiter: 'वेटर:',
    unassigned: 'कोई वेटर नहीं',
    waitingElsewhere: (count) =>
      count === 1
        ? 'एक ऑर्डर वेटर की मंज़ूरी का इंतज़ार कर रहा है। मंज़ूरी के बाद यह यहाँ दिखेगा।'
        : `${count} ऑर्डर वेटर की मंज़ूरी का इंतज़ार कर रहे हैं। मंज़ूरी के बाद ये यहाँ दिखेंगे।`,
    waitingRound: (round) => `राउंड ${round}, मंज़ूरी का इंतज़ार`,
    waitingForApproval: 'मंज़ूरी का इंतज़ार',
    note: (note) => `नोट: ${note}`,
    approve: 'मंज़ूर करें',
    reject: 'मना करें',
    roundSuffix: (round) => ` राउंड ${round}`,
    inRound: (round) => ` राउंड ${round} में`,
    openToOrder: 'टेबल खोलने के लिए ऑर्डर जोड़ें। बिल बनने तक टेबल खुली रहती है।',
    paused: 'रेस्टोरेंट के रीड-ओनली रहने तक नए ऑर्डर रुके हुए हैं।',
    pausedServe:
      'रेस्टोरेंट के रीड-ओनली रहने तक नए ऑर्डर रुके हुए हैं। पहले से ऑर्डर की गई डिश अब भी परोसी जा सकती हैं।',
    addDishes: 'डिश जोड़ें',
    addOrder: 'ऑर्डर जोड़ें',
    moveTable: 'टेबल बदलें',
    closeWithoutBill: 'बिना बिल बंद करें',
    approved: 'ऑर्डर मंज़ूर हुआ',
    rejectTitle: (round) => `राउंड ${round} मना करें`,
    rejectDescription:
      'ग्राहक को कारण दिखेगा। इस टेबल का अगला ऑर्डर फिर से मंज़ूरी का इंतज़ार करेगा।',
    rejectConfirm: 'ऑर्डर मना करें',
    rejected: 'ऑर्डर मना किया गया',
    closeTitle: (heading) => `${heading} बिना बिल बंद करें`,
    closeOnTheWay: (count) =>
      `अभी बाक़ी ${count} डिश रद्द ${
        count === 1 ? 'हो जाएगी' : 'हो जाएँगी'
      }; परोसी गई डिश रिकॉर्ड में रहेंगी। टेबल खाली हो जाएगी।`,
    closeEmpty: 'टेबल अगले मेहमानों के लिए खाली हो जाएगी।',
    closeConfirm: 'टेबल बंद करें',
    closed: (heading) => `${heading} बंद की गई`,
    round: (round) => `राउंड ${round}`,
    addedByStaff: 'स्टाफ़ ने जोड़ा',
    customer: 'ग्राहक',
    roundRejected: 'मना किया गया',
    roundDeleted: 'हटाया गया',
    roundCancelled: 'ग्राहक ने रद्द किया',
    rejectedReason: (reason) => `मना किया गया: ${reason}`,
    deletedBy: (name, reason) => `${name ? `${name} ने हटाया` : 'हटाया गया'}: ${reason}`,
    removedBy: (name, reason) =>
      `${name ? `${name} ने हटाया` : 'हटाया गया'}${reason ? `: ${reason}` : ''}`,
    markAllServed: 'सब परोस दिया',
    next: { preparing: 'बनाना शुरू करें', ready: 'तैयार है', served: 'परोस दिया' },
    remove: 'हटाएँ',
    askManager: 'हटाने के लिए मैनेजर से कहें',
  },
  add: {
    tooMany:
      'एक राउंड में ज़्यादा से ज़्यादा 30 अलग डिश हो सकती हैं। यह राउंड भेजें, फिर बाक़ी जोड़ें।',
    unavailable: (names) => {
      const one = names.length === 1;
      return `${listNames(names, 'और')} स्टॉक में नहीं ${one ? 'है' : 'हैं'} या मेन्यू में नहीं ${
        one ? 'है' : 'हैं'
      }, इसलिए ${one ? 'इसे' : 'इन्हें'} हटा दिया गया।`;
    },
    placedFirst: (heading) => `${heading} का ऑर्डर भेजा गया`,
    placedRound: (round, heading) => `राउंड ${round} किचन को भेजा गया · ${heading}`,
    nowYours: 'अब इस टेबल के वेटर आप हैं।',
    toSession: 'नए राउंड के रूप में किचन को जाएगा।',
    toNewSession: 'टेबल खुलेगी; ऑर्डर सीधे किचन को जाएगा।',
    changed: (heading, wasOpen) =>
      wasOpen
        ? `इस बीच ${heading} बंद हो गई या उसका बिल बन गया। यह ऑर्डर भेजने पर टेबल फिर से खुल जाएगी।`
        : `इस बीच किसी और ने ${heading} खोल दी। यह ऑर्डर उसी में जुड़ जाएगा।`,
    search: 'डिश खोजें',
    loadingMenu: 'मेन्यू लोड हो रहा है…',
    menuFailed: 'मेन्यू लोड नहीं हो पाया।',
    noMatch: (query) => `“${query}” से कोई डिश नहीं मिली।`,
    emptyMenu: 'मेन्यू में अभी कोई डिश नहीं है।',
    thisRound: 'यह राउंड',
    noteFor: (name) => `${name} के लिए नोट`,
    notePlaceholder: 'किचन के लिए नोट (वैकल्पिक)',
    roundNote: 'पूरे राउंड के लिए नोट',
    roundNotePlaceholder: 'पूरे राउंड के लिए नोट (वैकल्पिक)',
    noDishes: 'अभी कोई डिश नहीं',
    items: (count) => `${count} आइटम`,
    placing: 'भेजा जा रहा है…',
    place: 'ऑर्डर भेजें',
    addToRound: 'राउंड में जोड़ें',
    outOfStock: 'स्टॉक में नहीं',
    choose: 'चुनें',
    addName: (name) => ` · ${name} जोड़ें`,
    add: 'जोड़ें',
  },
  kitchen: {
    loading: 'ऑर्डर लोड हो रहे हैं…',
    columns: { placed: 'नए', preparing: 'बन रहे', ready: 'तैयार' },
    empty: {
      placed: 'कोई नया ऑर्डर नहीं',
      preparing: 'अभी कुछ नहीं बन रहा',
      ready: 'परोसने के लिए कुछ बाक़ी नहीं',
    },
    action: { placed: 'सब बनाना शुरू करें', preparing: 'सब तैयार है', ready: 'सब परोस दिया' },
    itemAction: { preparing: 'बनाना शुरू करें', ready: 'तैयार है', served: 'परोस दिया' },
    served: (names) => `${names} परोस दिया गया`,
    movedTo: (names, column) => `${names} अब “${column}” में`,
    goTo: 'कॉलम पर जाएँ',
    ticket: (heading, round) => `${heading}, राउंड ${round}`,
    round: (round) => `· राउंड ${round}`,
    late: 'देर · ',
    forTicket: (ticket) => ` — ${ticket}`,
  },
  stock: {
    title: 'उपलब्धता',
    intro:
      'कोई डिश या ऐड-ऑन ख़त्म हो जाए तो उसे बंद करें। ग्राहकों को वह तुरंत “उपलब्ध नहीं” दिखेगी।',
    back: (name) => `${name} फिर से स्टॉक में है`,
    out: (name) => `${name} स्टॉक में नहीं है`,
    empty: 'मेन्यू में अभी कोई डिश नहीं',
    emptyHint: 'मैनेजर एडमिन पैनल में डिश जोड़ सकते हैं।',
    noMatch: (query) => `“${query}” से कोई डिश नहीं मिली।`,
    addons: (group) => `ऐड-ऑन · ${group}`,
    inStock: 'स्टॉक में',
    outOfStock: 'स्टॉक में नहीं',
    switchLabel: (name) => `${name} स्टॉक में`,
  },
  alerts: {
    needsApproval: (table) => `${table} को मंज़ूरी चाहिए`,
    newOrder: (table) => `नया ऑर्डर · ${table}`,
    round: (round) => `राउंड ${round}`,
    calling: (table) => `${table} वेटर को बुला रही है`,
    bill: (table) => `${table} ने बिल माँगा`,
  },
  move: {
    moved: (heading) => `${heading} पर भेजा गया`,
    scan: (heading) => `मेहमानों से ${heading} का QR कोड स्कैन करने को कहें।`,
    title: (heading) => `${heading} बदलें`,
    description: 'कोई खाली टेबल चुनें। ऑर्डर, वेटर और बिल मेहमानों के साथ चले जाएँगे।',
    none: 'अभी बाक़ी सभी टेबल पर मेहमान हैं।',
    freeTables: 'खाली टेबल',
  },
  offline: {
    kept: (count) =>
      count === 1 ? '1 बदलाव इस डिवाइस पर रखा गया है' : `${count} बदलाव इस डिवाइस पर रखे गए हैं`,
    offlineKept: (kept) =>
      `ऑफ़लाइन। ${kept}; इंटरनेट लौटने पर भेज दिया जाएगा। बाक़ी कामों के लिए कनेक्शन चाहिए।`,
    offline:
      'ऑफ़लाइन। डिश की स्थिति के बदलाव इस डिवाइस पर रखे जाते हैं और इंटरनेट लौटने पर भेजे जाते हैं। बाक़ी कामों के लिए कनेक्शन चाहिए।',
    unreachable: (kept) => `सर्वर से संपर्क नहीं हो पा रहा। ${kept}; जवाब मिलते ही भेज दिया जाएगा।`,
  },
  reason: {
    required: 'कोई कारण चुनें या लिखें।',
    legend: 'कारण',
    other: 'अन्य…',
    otherLabel: 'अन्य कारण',
    cancel: 'रद्द करें',
    text: (reason) =>
      Object.hasOwn(HI_REASONS, reason) ? HI_REASONS[reason as keyof typeof HI_REASONS] : reason,
  },
  remove: {
    title: (name) => `${name} हटाएँ`,
    keeps: (left, name) =>
      `ऑर्डर में ${left} × ${name} ${left === 1 ? 'रहेगा' : 'रहेंगे'}। आपका कारण दर्ज होगा।`,
    struck: 'डिश ऑर्डर में कटी हुई दिखेगी, आपके कारण के साथ।',
    confirmSome: (count) => `${count} हटाएँ`,
    confirmAll: 'डिश हटाएँ',
    removedSome: (count, name) => `${count} × ${name} हटाया गया`,
    removed: (name) => `${name} हटाया गया`,
    howMany: 'कितने हटाने हैं',
    of: (count) => `${count} में से`,
    // The count is of dishes to remove, not to add.
    stepper: {
      group: (dish) => `हटाने के लिए ${dish} की संख्या`,
      remove: (dish) => `${dish} हटाएँ`,
      less: (dish) => `एक ${dish} कम हटाएँ`,
      more: (dish) => `एक और ${dish} हटाएँ`,
    },
  },
};

export const STAFF_STRINGS: Record<Lang, StaffStrings> = { en, hi };
