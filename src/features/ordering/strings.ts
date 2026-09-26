import type { FoodType } from '@/components/shared/food-type-mark';
import type { OrderItemStatus } from '@/lib/order-status';

import { CHOICE_WORDS } from './addons';
import { listNames, tableHeading } from './format';

/**
 * The customer panel's words in English and Hindi (spec §19 Phase 9,
 * docs/DECISIONS.md P9-7). Hindi has every English key (the compiler checks);
 * dish, category and restaurant names stay as the restaurant entered them, and
 * money and times stay in the en-IN format.
 */

export type Lang = 'en' | 'hi';

/** The phone's choice, on /t only; English until it picks Hindi. */
export const LANG_COOKIE = 'lang';

/** Each language by its own name, for the switch. */
export const LANG_NAMES: Record<Lang, string> = { en: 'English', hi: 'हिन्दी' };

function period(seconds: number, minute: string, second: string, plural = false) {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minute}${plural && minutes !== 1 ? 's' : ''}`;
  }
  return `${seconds} ${second}${plural && seconds !== 1 ? 's' : ''}`;
}

const en = {
  table: tableHeading,
  qrNotWorking: 'QR code not working',
  notFound: {
    title: 'This QR code isn’t working',
    body: 'Please ask the staff for help, or scan the code on your table again.',
  },
  loading: 'Loading…',
  /** Sonner's own labels (these English ones are its defaults). */
  toasts: { region: 'Notifications', close: 'Close toast' },
  networkError: 'We couldn’t reach the restaurant. Check your connection and try again.',
  genericError: 'Something went wrong. Please try again.',
  /** Refusals from the database, by code (spec §13.1: plain words, what to do next). */
  errors: {
    TABLE_NOT_FOUND: 'This QR code isn’t working any more. Please ask the staff for help.',
    ORDERING_UNAVAILABLE: 'Online ordering is unavailable right now. Please order with our staff.',
    ITEM_UNAVAILABLE: 'Some dishes are no longer available. We took them out of your cart.',
    RATE_LIMITED: 'Please wait a moment before ordering again.',
    INVALID_INPUT: 'Something in your order needs checking. Look over your cart and try again.',
    NOT_FOUND: 'This dish is no longer on your table’s order. Refresh the page.',
    NOT_YOUR_ITEM: 'Only the phone that ordered this dish can cancel it.',
    ITEM_NOT_CANCELLABLE: 'The kitchen has already started this dish. Please ask the staff.',
    CANCEL_WINDOW_EXPIRED: 'It’s too late to cancel this dish. Please ask the staff.',
  },
  /** Service requests word these refusals their own way. */
  requestErrors: {
    NOTHING_TO_BILL: 'Order something first, then you can ask for the bill.',
    RATE_LIMITED: 'The staff have been called several times. Please wave to them instead.',
  },
  service: {
    call_waiter: { idle: 'Call waiter', sent: 'Waiter called', toast: 'A waiter is on the way.' },
    request_bill: {
      idle: 'Request bill',
      sent: 'Bill requested',
      toast: 'The staff will bring your bill.',
    },
  },
  foodType: {
    veg: 'Vegetarian',
    non_veg: 'Non-vegetarian',
    egg: 'Contains egg',
  } satisfies Record<FoodType, string>,
  /** Customers read "Placed" where staff read "New" (spec §13 same action, same name). */
  status: {
    placed: 'Placed',
    preparing: 'Preparing',
    ready: 'Ready',
    served: 'Served',
    cancelled: 'Cancelled',
    removed: 'Removed',
  } satisfies Record<OrderItemStatus, string>,
  choices: CHOICE_WORDS,
  /** Why dishes left the cart (spec §13.1: show which, remove from cart). */
  unavailable: (names: string[]) => {
    const one = names.length === 1;
    return `${listNames(names)} ${one ? 'is' : 'are'} no longer available, so we removed ${
      one ? 'it' : 'them'
    } from your cart.`;
  },
  menu: {
    heading: 'Menu',
    cartFull: 'Your cart is full. Place this order first, then add more.',
    found: (count: number) =>
      count === 0 ? 'No dishes found.' : `${count} ${count === 1 ? 'dish' : 'dishes'} found.`,
    added: (name: string, inCart: number) => `${name} added. ${inCart} in cart.`,
    removed: (name: string) => `${name} removed from cart.`,
    inCartOf: (name: string, count: number) => `${count} ${name} in cart.`,
    tableOrders: (count: number) => `Your table’s orders (${count})`,
    notReady: 'The menu isn’t ready yet',
    orderWithStaff: 'Please order with our staff.',
    search: 'Search dishes',
    vegOnly: 'Veg only',
    noMatch: (query: string) => `No dishes match “${query}”`,
    noVeg: 'No veg dishes on this menu',
    turnOffVeg: 'Turn off Veg only to see all dishes.',
    tryAnotherOrVeg: 'Try another word, or turn off Veg only.',
    tryAnother: 'Try another word.',
    from: (price: string) => `from ${price}`,
    notAvailable: 'Not available',
    add: 'Add',
    addDish: (name: string) => `Add ${name}`,
    inCart: (count: number) => `${count} in cart`,
    categories: 'Menu categories',
  },
  cartBar: {
    items: (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`,
    view: 'View cart',
  },
  cart: {
    title: 'Your order',
    back: 'Back to the menu',
    placedWaiting: 'Order placed. Waiting for staff to confirm it.',
    placed: 'Order placed.',
    checkAndPlaceAgain: 'Check your order and place it again.',
    opening: 'Order placed. Opening your table’s orders…',
    empty: 'Your cart is empty',
    emptyHint: 'Add dishes from the menu to place an order.',
    browse: 'Browse the menu',
    addMore: 'Add more dishes',
    orderNote: 'Note for the whole order',
    optional: '(optional)',
    orderNoteExample: 'e.g. we’re celebrating a birthday',
    estimatedTotal: 'Estimated total',
    taxesLater: 'Taxes and charges, if any, are added to the final bill.',
    /** The notice above "Place order" (spec §13.1 Cart page). */
    cancelNotice: (seconds: number) => {
      const base = 'After you place the order, only staff can remove items.';
      return seconds > 0
        ? `${base} You can cancel an item within ${period(seconds, 'minute', 'second', true)} if the kitchen hasn’t started it.`
        : base;
    },
    placing: 'Placing order…',
    place: 'Place order',
    each: (price: string) => `${price} each`,
    dishNoteExample: 'e.g. less spicy',
    noteFor: (dish: string) => `Note for ${dish}`,
    addNoteFor: (dish: string) => `Add a note for ${dish}`,
    addNote: 'Add a note',
  },
  stepper: {
    group: (dish: string) => `Quantity of ${dish}`,
    remove: (dish: string) => `Remove ${dish}`,
    less: (dish: string) => `One less ${dish}`,
    more: (dish: string) => `One more ${dish}`,
  },
  options: {
    close: 'Close',
    chooseOption: 'Choose an option',
    quantity: 'Quantity',
    kitchenNote: 'Note for the kitchen',
    addToCart: 'Add to cart',
  },
  orders: {
    title: 'Your table’s orders',
    cancelled: (dish: string) => `${dish} cancelled.`,
    billed: 'Your bill has been generated. Please pay at the counter or to your server. Thank you!',
    newOrder: 'Start a new order',
    none: 'No orders yet',
    noneHint: 'Dishes you order from this table appear here.',
    waiting: 'Waiting for staff to confirm your order.',
    orderMore: 'Order more',
    stale: 'Couldn’t refresh the orders. Trying again…',
    cancelTitle: (dish: string) => `Cancel ${dish}?`,
    cancelBody: 'The kitchen won’t make it, and it won’t be on your bill.',
    keep: 'Keep it',
    cancelDish: 'Cancel dish',
    round: (round: number, time: string) => `Round ${round} · ${time}`,
    fromThisPhone: 'From this phone',
    rejected: (reason: string | null) =>
      reason
        ? `Staff couldn’t confirm this order: ${reason}`
        : 'Staff couldn’t confirm this order.',
    removed: (reason: string | null) =>
      reason ? `Removed by staff: ${reason}` : 'Removed by staff.',
    note: (note: string) => `Note: ${note}`,
    cancel: 'Cancel',
  },
};

export type Strings = typeof en;

const hi: Strings = {
  table: (label) => (/^\d/.test(label) ? `टेबल ${label}` : label),
  qrNotWorking: 'QR कोड काम नहीं कर रहा',
  notFound: {
    title: 'यह QR कोड काम नहीं कर रहा है',
    body: 'कृपया स्टाफ़ से मदद लें, या अपनी टेबल पर लगा कोड फिर से स्कैन करें।',
  },
  loading: 'लोड हो रहा है…',
  toasts: { region: 'सूचनाएँ', close: 'सूचना बंद करें' },
  networkError:
    'रेस्टोरेंट से संपर्क नहीं हो पाया। अपना इंटरनेट कनेक्शन जाँचें और फिर से कोशिश करें।',
  genericError: 'कुछ गड़बड़ हो गई। कृपया फिर से कोशिश करें।',
  errors: {
    TABLE_NOT_FOUND: 'यह QR कोड अब काम नहीं कर रहा। कृपया स्टाफ़ से मदद लें।',
    ORDERING_UNAVAILABLE: 'अभी ऑनलाइन ऑर्डर बंद है। कृपया हमारे स्टाफ़ से ऑर्डर करें।',
    ITEM_UNAVAILABLE: 'कुछ डिश अब उपलब्ध नहीं हैं। हमने उन्हें आपके कार्ट से हटा दिया है।',
    RATE_LIMITED: 'दोबारा ऑर्डर करने से पहले कृपया थोड़ा रुकें।',
    INVALID_INPUT: 'आपके ऑर्डर में कुछ ठीक नहीं है। कार्ट देखकर फिर से कोशिश करें।',
    NOT_FOUND: 'यह डिश अब आपकी टेबल के ऑर्डर में नहीं है। पेज रीफ़्रेश करें।',
    NOT_YOUR_ITEM: 'इस डिश को सिर्फ़ वही फ़ोन रद्द कर सकता है जिससे इसे ऑर्डर किया गया था।',
    ITEM_NOT_CANCELLABLE: 'किचन में यह डिश बननी शुरू हो गई है। कृपया स्टाफ़ से बात करें।',
    CANCEL_WINDOW_EXPIRED: 'इस डिश को रद्द करने का समय निकल गया है। कृपया स्टाफ़ से बात करें।',
  },
  requestErrors: {
    NOTHING_TO_BILL: 'पहले कुछ ऑर्डर करें, फिर बिल माँग सकते हैं।',
    RATE_LIMITED: 'स्टाफ़ को कई बार बुलाया जा चुका है। कृपया हाथ के इशारे से बुलाएँ।',
  },
  service: {
    call_waiter: { idle: 'वेटर बुलाएँ', sent: 'वेटर को बुलाया', toast: 'वेटर आ रहे हैं।' },
    request_bill: {
      idle: 'बिल मँगाएँ',
      sent: 'बिल माँगा गया',
      toast: 'स्टाफ़ आपका बिल ले आएगा।',
    },
  },
  foodType: { veg: 'शाकाहारी', non_veg: 'मांसाहारी', egg: 'अंडा युक्त' },
  status: {
    placed: 'ऑर्डर हुआ',
    preparing: 'बन रहा है',
    ready: 'तैयार',
    served: 'परोसा गया',
    cancelled: 'रद्द',
    removed: 'हटाया गया',
  },
  choices: {
    optional: 'वैकल्पिक',
    optionalUpTo: (max) => `वैकल्पिक, ${max} तक`,
    choose: (count) => `${count} चुनें`,
    chooseRange: (min, max) => `${min} से ${max} चुनें`,
    unavailable: 'एक विकल्प अब उपलब्ध नहीं है।',
    chooseFrom: (count, group) => `${group} में से ${count} चुनें।`,
    chooseAtLeast: (count, group) => `${group} में से कम से कम ${count} चुनें।`,
    chooseUpTo: (count, group) => `${group} में से ज़्यादा से ज़्यादा ${count} चुनें।`,
  },
  unavailable: (names) => {
    const one = names.length === 1;
    return `${listNames(names, 'और')} अब उपलब्ध नहीं ${one ? 'है' : 'हैं'}, इसलिए हमने ${
      one ? 'इसे' : 'इन्हें'
    } आपके कार्ट से हटा दिया है।`;
  },
  menu: {
    heading: 'मेन्यू',
    cartFull: 'आपका कार्ट भर गया है। पहले यह ऑर्डर करें, फिर और जोड़ें।',
    found: (count) =>
      count === 0 ? 'कोई डिश नहीं मिली।' : `${count} डिश ${count === 1 ? 'मिली' : 'मिलीं'}।`,
    added: (name, inCart) => `${name} जोड़ा गया। कार्ट में ${inCart}।`,
    removed: (name) => `${name} कार्ट से हटाया गया।`,
    inCartOf: (name, count) => `कार्ट में ${count} ${name}।`,
    tableOrders: (count) => `आपकी टेबल के ऑर्डर (${count})`,
    notReady: 'मेन्यू अभी तैयार नहीं है',
    orderWithStaff: 'कृपया हमारे स्टाफ़ से ऑर्डर करें।',
    search: 'डिश खोजें',
    vegOnly: 'सिर्फ़ वेज',
    noMatch: (query) => `“${query}” से कोई डिश नहीं मिली`,
    noVeg: 'इस मेन्यू में कोई वेज डिश नहीं है',
    turnOffVeg: 'सभी डिश देखने के लिए “सिर्फ़ वेज” बंद करें।',
    tryAnotherOrVeg: 'कोई दूसरा शब्द आज़माएँ, या “सिर्फ़ वेज” बंद करें।',
    tryAnother: 'कोई दूसरा शब्द आज़माएँ।',
    from: (price) => `${price} से शुरू`,
    notAvailable: 'उपलब्ध नहीं',
    add: 'जोड़ें',
    addDish: (name) => `${name} जोड़ें`,
    inCart: (count) => `कार्ट में ${count}`,
    categories: 'मेन्यू की श्रेणियाँ',
  },
  cartBar: { items: (count) => `${count} आइटम`, view: 'कार्ट देखें' },
  cart: {
    title: 'आपका ऑर्डर',
    back: 'मेन्यू पर वापस जाएँ',
    placedWaiting: 'ऑर्डर हो गया। स्टाफ़ की पुष्टि का इंतज़ार है।',
    placed: 'ऑर्डर हो गया।',
    checkAndPlaceAgain: 'अपना ऑर्डर जाँचें और फिर से करें।',
    opening: 'ऑर्डर हो गया। आपकी टेबल के ऑर्डर खुल रहे हैं…',
    empty: 'आपका कार्ट खाली है',
    emptyHint: 'ऑर्डर करने के लिए मेन्यू से डिश जोड़ें।',
    browse: 'मेन्यू देखें',
    addMore: 'और डिश जोड़ें',
    orderNote: 'पूरे ऑर्डर के लिए नोट',
    optional: '(वैकल्पिक)',
    orderNoteExample: 'जैसे, हम जन्मदिन मना रहे हैं',
    estimatedTotal: 'अनुमानित कुल',
    taxesLater: 'टैक्स और शुल्क, अगर कोई हों, फ़ाइनल बिल में जुड़ेंगे।',
    cancelNotice: (seconds) => {
      const base = 'ऑर्डर करने के बाद सिर्फ़ स्टाफ़ ही आइटम हटा सकता है।';
      return seconds > 0
        ? `${base} अगर किचन ने शुरू नहीं किया है, तो आप ${period(seconds, 'मिनट', 'सेकंड')} के अंदर कोई आइटम रद्द कर सकते हैं।`
        : base;
    },
    placing: 'ऑर्डर भेजा जा रहा है…',
    place: 'ऑर्डर करें',
    each: (price) => `${price} प्रति आइटम`,
    dishNoteExample: 'जैसे, कम तीखा',
    noteFor: (dish) => `${dish} के लिए नोट`,
    addNoteFor: (dish) => `${dish} के लिए नोट जोड़ें`,
    addNote: 'नोट जोड़ें',
  },
  stepper: {
    group: (dish) => `${dish} की संख्या`,
    remove: (dish) => `${dish} हटाएँ`,
    less: (dish) => `एक ${dish} कम करें`,
    more: (dish) => `एक और ${dish} जोड़ें`,
  },
  options: {
    close: 'बंद करें',
    chooseOption: 'एक विकल्प चुनें',
    quantity: 'संख्या',
    kitchenNote: 'किचन के लिए नोट',
    addToCart: 'कार्ट में जोड़ें',
  },
  orders: {
    title: 'आपकी टेबल के ऑर्डर',
    cancelled: (dish) => `${dish} रद्द कर दिया गया।`,
    billed: 'आपका बिल बन गया है। कृपया काउंटर पर या अपने वेटर को भुगतान करें। धन्यवाद!',
    newOrder: 'नया ऑर्डर शुरू करें',
    none: 'अभी कोई ऑर्डर नहीं',
    noneHint: 'इस टेबल से ऑर्डर की गई डिश यहाँ दिखेंगी।',
    waiting: 'स्टाफ़ आपके ऑर्डर की पुष्टि करेगा। कृपया इंतज़ार करें।',
    orderMore: 'और ऑर्डर करें',
    stale: 'ऑर्डर रीफ़्रेश नहीं हो पाए। फिर से कोशिश कर रहे हैं…',
    cancelTitle: (dish) => `${dish} रद्द करें?`,
    cancelBody: 'किचन इसे नहीं बनाएगा, और यह आपके बिल में नहीं जुड़ेगा।',
    keep: 'रहने दें',
    cancelDish: 'डिश रद्द करें',
    round: (round, time) => `राउंड ${round} · ${time}`,
    fromThisPhone: 'इस फ़ोन से',
    rejected: (reason) =>
      reason
        ? `स्टाफ़ इस ऑर्डर की पुष्टि नहीं कर सका: ${reason}`
        : 'स्टाफ़ इस ऑर्डर की पुष्टि नहीं कर सका।',
    removed: (reason) => (reason ? `स्टाफ़ ने हटाया: ${reason}` : 'स्टाफ़ ने हटाया।'),
    note: (note) => `नोट: ${note}`,
    cancel: 'रद्द करें',
  },
};

export const STRINGS: Record<Lang, Strings> = { en, hi };

/** The customer's words for a refusal code, or null for one they shouldn't see. */
export function refusalMessage(
  messages: Record<string, string>,
  code: string | null,
): string | null {
  return code !== null && Object.hasOwn(messages, code) ? messages[code]! : null;
}
