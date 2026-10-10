import type { CuisineSet } from '@/features/menu/default-categories';
import type { FeatureKey } from '@/features/plans/plan-features';

/**
 * The public website's words (docs/DECISIONS.md W-1 to W-4), one dictionary per
 * language. Every claim here is something the product does today; no invented
 * customers, logos or numbers.
 *
 * Plain data only: `{slot}` placeholders filled by fill() and fillNodes(), and
 * `{ one, other }` plurals (i18n.tsx). Icons and pictures live with their
 * components, by position. Server components read SITE[lang]; client
 * components get their words as props.
 */

/** A line in a list; `plan` marks what needs the Growth plan or above (SPEC §14.1). */
type Point = { text: string; plan?: 'growth' };

const en = {
  /** The link past the header, for keyboard users. */
  skipToContent: 'Skip to content',
  login: 'Log in',
  /** The product in one line: the footer and the structured data. */
  tagline: 'QR table ordering, kitchen and waiter screens, and billing for restaurants in India.',
  /** The website's main calls to action; `signup` once self-serve signup is open (W-9). */
  cta: { demo: 'Book a demo', signup: 'Start free trial' },
  growthBadge: 'Growth plan',

  nav: [
    { href: '/#how', label: 'How it works' },
    { href: '/features', label: 'Features' },
    { href: '/pricing', label: 'Pricing' },
    { href: '/demo', label: 'Demo' },
    { href: '/contact', label: 'Contact' },
  ],
  header: { home: '{app} home', main: 'Main' },
  footer: {
    columns: [
      {
        title: 'Product',
        links: [
          { href: '/#how', label: 'How it works' },
          { href: '/features', label: 'Features' },
          { href: '/pricing', label: 'Pricing' },
          { href: '/demo', label: 'Try the demo' },
          { href: '/#faq', label: 'FAQ' },
          { href: '/login', label: 'Log in' },
        ],
      },
      {
        title: 'Company',
        links: [{ href: '/contact', label: 'Contact' }],
      },
      {
        title: 'Legal',
        links: [
          { href: '/terms', label: 'Terms of service' },
          { href: '/privacy', label: 'Privacy policy' },
          { href: '/refund', label: 'Refunds and cancellation' },
          { href: '/shipping', label: 'Shipping and delivery' },
        ],
      },
    ],
  },

  home: {
    meta: {
      title: 'QR table ordering for restaurants',
      description:
        'Guests order from their phone by scanning the table QR code. Kitchen and waiter screens update live, and bills print in one tap. Made for restaurants in India.',
    },
  },
  hero: {
    title: 'Your menu on every table. Orders straight to the kitchen.',
    lead: 'Guests scan the QR code on their table and order from their own phone. Every dish reaches your waiter and kitchen screens, moves from the kitchen to the table, and the bill is ready in one tap.',
    secondary: 'See how it works',
    customers: 'Already using MenuMesh? {login}',
  },
  /** The hero animation's story, also read out as its text alternative. */
  storySteps: [
    'A guest at table 5 adds Paneer Tikka from their phone.',
    'A waiter takes the table, and the order reaches the kitchen screen.',
    'The kitchen marks it preparing, then ready.',
    'The waiter serves it, and the guest sees it served.',
    'The bill prints, and the payment is recorded.',
  ],
  problems: {
    title: 'Running a busy floor on paper is hard',
    lead: 'Orders, the kitchen and the bill all depend on slips and memory. MenuMesh puts them on one screen everyone shares.',
    items: [
      {
        title: 'Paper slips go missing',
        body: 'Handwritten orders get misread, lost between the floor and the kitchen, or cooked twice.',
      },
      {
        title: 'Guests wait to order and to pay',
        body: 'At a busy hour, tables wait for a waiter to take the order, and wait again for the bill.',
      },
      {
        title: 'You can’t see the floor',
        body: 'Which table ordered what, what is still cooking, who is serving whom: it lives in people’s heads.',
      },
    ],
  },
  how: {
    title: 'How it works',
    lead: 'From the first scan to a free table, in four steps your staff already know.',
    steps: [
      {
        title: 'Scan',
        body: 'Each table has its own QR code. Guests scan it and your menu opens, already tied to their table. No app, no login.',
      },
      {
        title: 'Order',
        body: 'They pick dishes, options and add-ons, add a note, and place the order. Friends at the same table can order from their own phones, round after round.',
      },
      {
        title: 'Cook and serve',
        body: 'Waiters see the order straight away, and the kitchen gets it once a waiter takes the table. Every dish moves from placed to preparing, ready and served, and the guest sees it move too.',
      },
      {
        title: 'Bill and pay',
        body: 'One tap makes the bill with your taxes and charges. Print it, take payment the way you already do, and the table is free for the next guests.',
      },
    ],
  },
  roles: {
    title: 'One system for the whole restaurant',
    lead: 'Guests, the floor, the kitchen and the counter each get a screen made for what they do.',
    items: [
      {
        id: 'guests',
        title: 'For your guests',
        points: [
          { text: 'Order from their own phone, in English or हिन्दी' },
          { text: 'See each dish move from the kitchen to the table' },
          { text: 'Cancel a dish within a short window, call a waiter, ask for the bill' },
          { text: 'No app to install and nothing to sign up for' },
        ],
      },
      {
        id: 'staff',
        title: 'For waiters and the kitchen',
        points: [
          { text: 'A live board of every table, colour-coded by dish status' },
          { text: 'Add or remove dishes, move guests to another table' },
          { text: 'Keeps saving dish updates through a short Wi-Fi drop' },
          { text: 'A kitchen view of what to cook next', plan: 'growth' },
        ],
      },
      {
        id: 'owners',
        title: 'For owners and managers',
        points: [
          { text: 'Approve first orders to stop prank orders' },
          { text: 'Bills with GST and service charge, printed on 80 or 58 mm paper' },
          { text: 'Record cash, UPI and card payments; see today’s sales' },
          {
            text: 'Discounts, split payments, dish and waiter reports, CSV export',
            plan: 'growth',
          },
        ],
      },
    ] as Array<{ id: string; title: string; points: Point[] }>,
  },
  highlights: {
    title: 'Made for restaurants in India',
    lead: 'The details that matter on a real service.',
    items: [
      {
        title: 'Menu from a photo',
        body: 'Photograph your printed menu, or upload a PDF or CSV. Check the dishes, then add them in one go.',
      },
      {
        title: 'English and हिन्दी',
        body: 'Guests switch the menu to Hindi in one tap. Dish names are written in Hindi for you, and you can change any of them.',
      },
      {
        title: 'Live status colours',
        body: 'Placed, preparing, ready, served: the same colours on every screen, so everyone knows where each dish is.',
      },
      {
        title: 'Ready for a Wi-Fi drop',
        body: 'Dishes marked on the staff board are kept on the device and sent the moment the connection is back.',
      },
      {
        title: 'Prints on receipt printers',
        body: 'Bills are laid out for 80 mm and 58 mm thermal printers and print from your device’s normal print dialog.',
      },
      {
        title: 'GST and charges',
        body: 'Set your GST, service charge and bill details once. Every bill adds them up the same way.',
      },
      {
        plan: 'growth',
        title: 'UPI QR on the bill',
        body: 'Print your own UPI QR code on the bill. Payments go straight to you; MenuMesh never touches them.',
      },
      {
        plan: 'growth',
        title: 'Reports that add up',
        body: 'Sales by day, dish and waiter, payment modes, and every completed table, with CSV export.',
      },
    ],
  },
  hindi: {
    title: 'Your menu, in your guests’ language',
    body: 'One tap switches the whole menu to हिन्दी: buttons, the cart, order status, and your dish names. MenuMesh writes each dish name in Hindi for you, and you can change any of them in the menu editor.',
  },
  nextSteps: {
    label: 'Next steps',
    demo: {
      title: 'Try it in your browser',
      body: 'Order as a guest, cook in the kitchen and bill at the counter, all on one page. Nothing to sign up for.',
      link: 'Open the demo',
    },
    pricing: {
      title: 'Plans and pricing',
      /** With the lowest monthly price. */
      from: 'Plans from {price} a month + GST',
      body: 'Every plan has QR ordering, the staff board, bills and the Hindi menu. No commission on your sales.',
      link: 'Compare plans',
    },
  },
  faq: {
    title: 'Questions owners ask',
    items: [
      {
        q: 'Do my guests need to install an app?',
        a: 'No. They scan the QR code on the table with their phone camera and the menu opens in the browser. There is nothing to install and no login.',
      },
      {
        q: 'What devices do I need?',
        a: 'Any phone, tablet or laptop with a modern browser. A common setup is a tablet in the kitchen, waiters’ own phones, and a laptop or tablet at the counter. The staff screens can be added to the home screen like an app.',
      },
      {
        q: 'Which printer works?',
        a: 'Bills are laid out for 80 mm and 58 mm thermal (receipt) printers and print through your device’s normal print dialog, so a receipt printer your device can already print to will work.',
      },
      {
        q: 'Does MenuMesh take payments from my guests?',
        a: 'No. Your guests pay you the way they do today: cash, your UPI, or your card machine. MenuMesh records how each bill was paid, and can print your UPI QR code on the bill.',
      },
      {
        q: 'Can guests send fake orders?',
        a: 'You can have each table’s first order wait for a waiter to approve it. Once a waiter is assigned, the table orders freely.',
      },
      {
        q: 'What if the internet drops?',
        a: 'Dish updates on the staff board are saved on the device and sent when the connection returns. Other actions tell you straight away that they could not reach the server, so nothing surprises you later.',
      },
      {
        q: 'Where is my data kept?',
        a: 'In India: the app and its database run in Mumbai. Each restaurant’s data is kept apart from every other restaurant’s, and your staff see only what their role allows.',
      },
      {
        q: 'What happens if I stop paying?',
        a: 'After a short grace period your restaurant becomes read-only: nothing is deleted, open tables can still be billed, and new orders stop until the plan is renewed.',
      },
    ],
  },
  finalCta: {
    title: 'See it running in your restaurant',
    body: 'We’ll set up your menu and tables with you, and you can try MenuMesh free for 14 days on the Growth plan.',
    /** When visitors can sign up themselves. */
    signupBody:
      'Try MenuMesh free for 14 days on the Growth plan. Set it up yourself in minutes, or book a demo and we’ll help.',
  },

  featuresPage: {
    meta: {
      title: 'Features',
      description:
        'QR ordering for guests, a live board for waiters, a kitchen view, one-tap bills and reports for owners. See each screen of MenuMesh.',
    },
    title: 'Everything from the table to the bill',
    lead: 'One system for your guests, waiters, kitchen and counter. Every picture on this page is the real app.',
    onThisPage: 'On this page',
    /** One section per role. */
    sections: [
      {
        id: 'guests',
        nav: 'Guests',
        title: 'Guests order from their own phone',
        lead: 'The QR code on the table opens your menu in the phone’s browser, already tied to that table.',
        points: [
          { text: 'No app to install and no login' },
          { text: 'Categories, a veg-only switch and search' },
          { text: 'Sizes and add-ons, and a note for the kitchen' },
          { text: 'Menu buttons and dish names in English or हिन्दी' },
          { text: 'Each dish’s status, live: placed, preparing, ready, served' },
          { text: 'Cancel a dish in the first moments, call a waiter, ask for the bill' },
          { text: 'Friends at the table order from their own phones, round after round' },
        ],
      },
      {
        id: 'waiters',
        nav: 'Waiters',
        title: 'Waiters see every table at a glance',
        lead: 'A live board on any phone or tablet, coloured by how far each table’s order has got.',
        points: [
          { text: 'New orders appear straight away, with a chime if you turn sound on' },
          { text: 'Approve a table’s first order to stop prank orders' },
          { text: 'Take a table, add or remove dishes, move guests to another table' },
          { text: 'A badge when a guest calls a waiter or asks for the bill' },
          { text: 'Mark a dish out of stock from the floor' },
          { text: 'Dish updates are kept through a short Wi-Fi drop and sent when it’s back' },
        ],
      },
      {
        id: 'kitchen',
        nav: 'Kitchen',
        title: 'The kitchen sees what to cook next',
        lead: 'Tickets for every table, in columns for new, preparing and ready.',
        plan: 'growth',
        points: [
          { text: 'Each ticket shows its table, round, dishes and notes' },
          { text: 'Start or finish a whole ticket, or one dish at a time' },
          { text: 'Waiters and guests see each change at once' },
        ],
      },
      {
        id: 'billing',
        nav: 'Billing',
        title: 'Bills in one tap',
        lead: 'The counter makes the bill from everything the table ordered, with your taxes and charges.',
        points: [
          { text: 'GST and service charge added the same way on every bill' },
          { text: 'Prints on 80 mm and 58 mm receipt printers' },
          { text: 'Record cash, UPI or card on each bill' },
          { text: 'Discounts and split payments', plan: 'growth' },
          { text: 'Your UPI QR code printed on the bill', plan: 'growth' },
        ],
      },
      {
        id: 'owners',
        nav: 'Owners and managers',
        title: 'Owners and managers stay in charge',
        lead: 'Set the restaurant up once, then see how it’s doing every day.',
        points: [
          {
            text: 'Menu with categories, sizes and add-ons, or imported from a photo, PDF or CSV',
          },
          { text: 'Tables with printable QR codes' },
          {
            text: 'Staff logins for managers, waiters and the kitchen, each seeing only their part',
          },
          { text: 'Today’s sales and a daily report' },
          { text: 'Sales by dish and waiter, busy hours and CSV export', plan: 'growth' },
        ],
      },
    ] as Array<{
      id: string;
      /** Its name in the page's jump links. */
      nav: string;
      title: string;
      lead: string;
      plan?: Point['plan'];
      points: Point[];
    }>,
    /** The screenshots in ./shots. */
    alts: {
      guestMenu: 'The guest menu on a phone, with three dishes in the cart',
      guestMenuHindi: 'The same menu in Hindi',
      guestOrders: 'The guest’s order, each dish showing placed, preparing or ready',
      staffBoard: 'The waiters’ live board: eight tables, coloured by status, one calling a waiter',
      kitchen: 'The kitchen view: tickets in columns for new, preparing and ready',
      bill: 'A paid bill with CGST and SGST, the payment by UPI and the table’s history',
      reports: 'Today’s sales report: bills, gross and net sales, GST and how it was paid',
    },
  },

  pricing: {
    meta: {
      title: 'Pricing',
      description:
        'Plans for every size of restaurant, paid monthly or yearly. QR ordering, the staff board, bills and the Hindi menu in every plan.',
    },
    title: 'Simple plans for every size of restaurant',
    lead: 'Every plan has QR ordering, the staff board, bills and the Hindi menu. Pick the one that fits your tables and team.',
    trial: 'Try the {plan} plan free for {days} days.',
    /** Under each plan's name, by plan code. */
    blurbs: {
      starter: 'For cafés and small restaurants starting with QR ordering.',
      growth: 'For busy restaurants with a kitchen screen and a team on the floor.',
      pro: 'For large restaurants: no limits, and no “Powered by” line on bills.',
    } as Record<string, string>,
    everyPlan: [
      'Guests order from their own phone by QR code, no app',
      'Menu in English and हिन्दी',
      'Live staff board for waiters',
      'Bills with GST and service charge, for 80 and 58 mm printers',
      'Cash, UPI and card payments recorded on each bill',
      'Menu import from a photo, PDF or CSV',
      'Today’s sales and a daily report',
    ],
    limits: {
      tables: { unlimited: 'Unlimited tables', upTo: 'Up to {n} tables' },
      staff: { unlimited: 'Unlimited staff logins', upTo: 'Up to {n} staff logins' },
    },
    /** Self-serve signups set up for free (docs/DECISIONS.md W-10). */
    setupFee: {
      signup:
        'Setting up yourself is free. Or we set up your menu and tables with you for a one-time {fee}, with printed QR codes for your tables.',
      demo: 'One-time setup fee of {fee}: we set up your menu and tables with you, with printed QR codes for your tables.',
    },
    gst: 'All prices are before GST: 18% is added to each payment.',
    noCommission:
      'No commission on your sales. Guests pay you directly, by cash, your UPI or your card machine; MenuMesh never touches that money.',
    fit: {
      title: 'Which plan fits me?',
      lead: 'Tell us about your restaurant and we’ll pick the plan that covers it.',
    },
    compare: {
      title: 'Compare the plans',
      caption: 'What each plan includes',
      tables: 'Tables',
      staff: 'Staff logins',
      unlimited: 'Unlimited',
      included: 'Included in {plan}',
      notIncluded: 'Not in {plan}',
    },
    faq: {
      title: 'Pricing questions',
      items: [
        {
          q: 'What counts as a staff login?',
          a: 'Each waiter, kitchen or manager account that signs in. You, the owner, don’t count, and waiters you only name on tables, without a login of their own, don’t count either.',
        },
        {
          q: 'What counts as a table?',
          a: 'Each table with its own QR code.',
        },
        {
          q: 'What if I outgrow my plan?',
          a: 'Nothing stops working. You can’t add more tables or staff logins than your plan allows until you move to a bigger plan.',
        },
        {
          q: 'What happens when the free trial ends?',
          a: 'Choose a plan to keep going. If the plan isn’t paid, your restaurant becomes read-only after a short grace period: nothing is deleted, and it comes back as soon as the plan is renewed.',
        },
        {
          q: 'Do you take a share of my sales?',
          a: 'No. You pay for your plan, and a one-time setup fee only if we set up your restaurant for you, plus 18% GST on each payment. Food payments go straight from your guests to you.',
        },
      ],
    },
  },

  demo: {
    meta: {
      title: 'Try the demo',
      description:
        'Order from a guest’s phone, move the dishes through the kitchen and make the bill at the counter, all in your browser. Nothing is saved and no sign-up is needed.',
    },
    title: 'Try MenuMesh in your browser',
    lead: 'Be the guest, the kitchen and the counter for table 5. Nothing is saved, and you don’t need to sign up.',
    ownMenu: 'Want to see it with your own menu and tables?',
  },

  contact: {
    meta: {
      title: 'Book a demo',
      description: 'Talk to us about QR ordering, kitchen screens and billing for your restaurant.',
    },
    title: 'Book a demo',
    lead: 'Tell us about your restaurant. We’ll show you MenuMesh on your own menu, set up your tables with you, and you can try MenuMesh free for 14 days on the Growth plan.',
    /** Above the contact details, with and without the form. */
    reachUs: { withForm: 'Or reach us directly', alone: 'Reach us directly' },
    placeholder: 'Placeholder — the contact details below are filled in before launch.',
    /** Email, phone and WhatsApp; placeholders until launch (W-2). */
    ways: [
      { title: 'Email', detail: '[Support email]' },
      { title: 'Phone', detail: '[Phone number and hours]' },
      { title: 'WhatsApp', detail: '[WhatsApp number]' },
    ],
  },

  signup: {
    meta: {
      title: 'Start your free trial',
      description: 'Set up QR ordering, the staff board and bills for your restaurant in minutes.',
    },
    title: 'Start your free trial',
    lead: 'Set up your restaurant in a few minutes. Nothing to pay today.',
    freeDays: 'Your first {days} days are free on the Growth plan.',
    perksTitle: 'What you get',
    perks: [
      'Every Growth feature free for the length of your trial',
      'No card needed to start; set up autopay when you’re ready',
      'Import your menu from a photo, then print QR codes for your tables',
      'Cancel any time: your data stays yours',
    ],
    afterTrial: 'After the trial: the {plan} plan at {price} {per} + GST, once you set up autopay.',
    per: { monthly: 'a month', yearly: 'a year' },
    haveAccount: 'Already have an account? {login}',
  },

  verify: {
    meta: { title: 'Check your email' },
    title: 'Check your email',
    sent: 'We sent a 6-digit code to {email}. Enter it below with a password to create your restaurant.',
  },

  /** The plans in search results (structured-data.tsx), monthly and yearly. */
  offers: { monthly: '{plan}, monthly', yearly: '{plan}, yearly' },

  /** The site's own copies of the panels' labels, so each language can word them. */
  labels: {
    features: {
      kds: 'Kitchen view',
      discounts: 'Discounts',
      split_payments: 'Split payments',
      upi_qr_on_bill: 'UPI QR on bills',
      advanced_reports: 'Advanced reports',
      waiter_reports: 'Waiter report',
      csv_export: 'CSV export',
      remove_branding: 'No "Powered by" line',
    } satisfies Record<FeatureKey, string>,
    cuisines: {
      north_indian: 'North Indian',
      south_indian: 'South Indian',
      cafe: 'Café',
      fast_food: 'Fast food',
      bakery: 'Bakery',
      multi_cuisine: 'Multi-cuisine',
      blank: 'Start empty',
    } satisfies Record<CuisineSet, string>,
  },
};

export type SiteContent = typeof en;

export const SITE = { en };

export type SiteLang = keyof typeof SITE;

// For the client components, until they take their words as props.
export const SITE_NAV = en.nav;
export const CTA = en.cta;
export const STORY_STEPS = en.storySteps;
export const STEPS = en.how.steps;
export const PRICING = en.pricing;
export const LABELS = en.labels;
