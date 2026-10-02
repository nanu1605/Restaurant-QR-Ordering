/**
 * The public website's copy (docs/DECISIONS.md W-1 to W-4), in one place so a
 * Hindi version can follow the same shape. Every claim here is something the
 * product does today; no invented customers, logos or numbers.
 */

export const SITE_NAV = [
  { href: '/#how', label: 'How it works' },
  { href: '/#features', label: 'Features' },
  { href: '/#faq', label: 'FAQ' },
  { href: '/contact', label: 'Contact' },
] as const;

export const HERO = {
  title: 'Your menu on every table. Orders straight to the kitchen.',
  lead: 'Guests scan the QR code on their table and order from their own phone. Every dish reaches your waiter and kitchen screens, moves from the kitchen to the table, and the bill is ready in one tap.',
  primary: 'Book a demo',
  secondary: 'See how it works',
} as const;

/** The hero animation's story, also read out as its text alternative. */
export const STORY_STEPS = [
  'A guest at table 5 adds Paneer Tikka from their phone.',
  'A waiter takes the table, and the order reaches the kitchen screen.',
  'The kitchen marks it preparing, then ready.',
  'The waiter serves it, and the guest sees it served.',
  'The bill prints, and the payment is recorded.',
] as const;

export const PROBLEMS = [
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
] as const;

export const STEPS = [
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
] as const;

/** `plan` marks what needs the Growth plan or above (SPEC §14.1). */
export type SitePlan = 'growth';

export const ROLES: ReadonlyArray<{
  id: string;
  title: string;
  points: ReadonlyArray<{ text: string; plan?: SitePlan }>;
}> = [
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
];

export const HIGHLIGHTS = [
  {
    icon: 'camera',
    title: 'Menu from a photo',
    body: 'Photograph your printed menu, or upload a PDF or CSV. Check the dishes, then add them in one go.',
  },
  {
    icon: 'languages',
    title: 'English and हिन्दी',
    body: 'Guests switch the menu to Hindi in one tap. Dish names are written in Hindi for you, and you can change any of them.',
  },
  {
    icon: 'activity',
    title: 'Live status colours',
    body: 'Placed, preparing, ready, served: the same colours on every screen, so everyone knows where each dish is.',
  },
  {
    icon: 'wifi-off',
    title: 'Ready for a Wi-Fi drop',
    body: 'Dishes marked on the staff board are kept on the device and sent the moment the connection is back.',
  },
  {
    icon: 'printer',
    title: 'Prints on receipt printers',
    body: 'Bills are laid out for 80 mm and 58 mm thermal printers and print from your device’s normal print dialog.',
  },
  {
    icon: 'receipt',
    title: 'GST and charges',
    body: 'Set your GST, service charge and bill details once. Every bill adds them up the same way.',
  },
  {
    icon: 'qr-code',
    plan: 'growth',
    title: 'UPI QR on the bill',
    body: 'Print your own UPI QR code on the bill. Payments go straight to you; MenuMesh never touches them.',
  },
  {
    icon: 'chart',
    plan: 'growth',
    title: 'Reports that add up',
    body: 'Sales by day, dish and waiter, payment modes, and every completed table, with CSV export.',
  },
] as const;

export type HighlightIcon = (typeof HIGHLIGHTS)[number]['icon'];

export const FAQ = [
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
] as const;

export const FINAL_CTA = {
  title: 'See it running in your restaurant',
  body: 'We’ll set up your menu and tables with you, and you can try MenuMesh free for 14 days on the Growth plan.',
} as const;
