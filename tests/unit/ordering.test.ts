import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import {
  accentColors,
  contrastRatio,
  customerThemeCss,
  DEFAULT_ACCENT,
} from '@/features/ordering/accent';
import {
  addToCart,
  cartCount,
  cartTotalPaise,
  EMPTY_CART,
  itemQuantity,
  lineKey,
  parseStoredCart,
  randomUuid,
  reconcileCart,
  refusedKeys,
  removeLines,
  serializeCart,
  setLineNote,
  setLineQuantity,
  setOrderNote,
  toOrderLines,
  type Cart,
  type CartLine,
  type NewCartLine,
} from '@/features/ordering/cart';
import {
  createDeviceToken,
  DEVICE_COOKIE,
  deviceCookieOptions,
  newDeviceId,
  verifyDeviceToken,
} from '@/features/ordering/device-token';
import {
  formatClockTime,
  formatCountdown,
  listNames,
  tableHeading,
} from '@/features/ordering/format';
import {
  IDEMPOTENCY_KEY_PATTERN,
  MAX_LINE_NOTE,
  MAX_LINE_QUANTITY,
  MAX_ORDER_LINES,
  MAX_ORDER_NOTE,
} from '@/features/ordering/limits';
import { countItems, filterMenu } from '@/features/ordering/menu-filter';
import { placeOrderSchema, qrTokenSchema, toOrderItemsPayload } from '@/features/ordering/schemas';
import { refusalMessage, STRINGS } from '@/features/ordering/strings';
import type { CustomerCategory, CustomerMenuItem } from '@/features/ordering/types';
import { dbErrorCode, type DbErrorLike, dbErrorMessage } from '@/lib/db-errors';

const { en, hi } = STRINGS;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const PANEER = '11111111-1111-4111-8111-111111111111';
const CHICKEN_65 = '22222222-2222-4222-8222-222222222222';
const BUTTER_CHICKEN = '33333333-3333-4333-8333-333333333333';
const DAL = '44444444-4444-4444-8444-444444444444';
const CUSTARD = '55555555-5555-4555-8555-555555555555';
const HALF = '66666666-6666-4666-8666-666666666666';
const FULL = '77777777-7777-4777-8777-777777777777';
const LARGE = '88888888-8888-4888-8888-888888888888';

// ─── Menu fixtures ──────────────────────────────────────────────────────────

function menuItem(
  item: Pick<CustomerMenuItem, 'id' | 'name'> & Partial<CustomerMenuItem>,
): CustomerMenuItem {
  return {
    description: null,
    foodType: 'veg',
    pricePaise: 10000,
    imageUrl: null,
    isAvailable: true,
    variants: [],
    addonGroups: [],
    ...item,
  };
}

const MENU: CustomerCategory[] = [
  {
    id: 'starters',
    name: 'Starters',
    items: [
      menuItem({
        id: PANEER,
        name: 'Paneer Tikka',
        description: 'Char-grilled cottage cheese',
        pricePaise: 28000,
      }),
      menuItem({
        id: CHICKEN_65,
        name: 'Chicken 65',
        description: 'Spicy fried chicken',
        foodType: 'non_veg',
        pricePaise: 32000,
      }),
    ],
  },
  {
    id: 'mains',
    name: 'Main Course',
    items: [
      menuItem({
        id: BUTTER_CHICKEN,
        name: 'Butter Chicken',
        description: 'Creamy tomato gravy',
        foodType: 'non_veg',
        pricePaise: 24000,
        variants: [
          { id: HALF, name: 'Half', pricePaise: 24000 },
          { id: FULL, name: 'Full', pricePaise: 42000 },
        ],
      }),
      menuItem({ id: DAL, name: 'Dal Makhani', pricePaise: 26000 }),
    ],
  },
  {
    id: 'desserts',
    name: 'Desserts',
    items: [
      menuItem({
        id: CUSTARD,
        name: 'Caramel Custard',
        description: 'Baked egg custard',
        foodType: 'egg',
        pricePaise: 15000,
      }),
    ],
  },
];

/** MENU with one dish changed. */
function withItem(id: string, change: Partial<CustomerMenuItem>): CustomerCategory[] {
  return MENU.map((category) => ({
    ...category,
    items: category.items.map((item) => (item.id === id ? { ...item, ...change } : item)),
  }));
}

const itemNames = (menu: CustomerCategory[]) =>
  menu.map((category) => [category.name, category.items.map((item) => item.name)]);

// ─── Cart fixtures ──────────────────────────────────────────────────────────

const paneer: NewCartLine = {
  menuItemId: PANEER,
  variantId: null,
  name: 'Paneer Tikka',
  variantName: null,
  foodType: 'veg',
  unitPricePaise: 28000,
};
const chickenFull: NewCartLine = {
  menuItemId: BUTTER_CHICKEN,
  variantId: FULL,
  name: 'Butter Chicken',
  variantName: 'Full',
  foodType: 'non_veg',
  unitPricePaise: 42000,
};
const chickenHalf: NewCartLine = {
  ...chickenFull,
  variantId: HALF,
  variantName: 'Half',
  unitPricePaise: 24000,
};

const cartLine = (line: NewCartLine, quantity = 1, note = ''): CartLine => ({
  ...line,
  quantity,
  note,
});
const cartOf = (lines: CartLine[], note = ''): Cart => ({ lines, note });

/** A distinct simple dish per number, for filling the cart. */
const dish = (n: number): NewCartLine => ({
  menuItemId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  variantId: null,
  name: `Dish ${n}`,
  variantName: null,
  foodType: 'veg',
  unitPricePaise: 10000,
});

function filledCart(lines: number): Cart {
  let cart: Cart = EMPTY_CART;
  for (let n = 1; n <= lines; n += 1) cart = addToCart(cart, dish(n))!;
  return cart;
}

// ─── Device cookie ──────────────────────────────────────────────────────────

describe('device cookie (spec §9.2)', () => {
  const SECRET = 'unit-test-cookie-secret-0123456789abcdef';
  const DEVICE = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const OTHER_DEVICE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const key = new TextEncoder().encode(SECRET);
  const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  it('round-trips the device id', async () => {
    const token = await createDeviceToken(DEVICE, SECRET);
    expect(token.split('.')).toHaveLength(3);
    await expect(verifyDeviceToken(token, SECRET)).resolves.toBe(DEVICE);
  });

  it('gives every phone its own random uuid', async () => {
    const first = newDeviceId();
    expect(first).toMatch(UUID_V4);
    expect(newDeviceId()).not.toBe(first);
    await expect(verifyDeviceToken(await createDeviceToken(first, SECRET), SECRET)).resolves.toBe(
      first,
    );
  });

  it('rejects a tampered token', async () => {
    const [header, payload, signature] = (await createDeviceToken(DEVICE, SECRET)).split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as object;
    const forged = base64url({ ...claims, sub: OTHER_DEVICE });
    await expect(verifyDeviceToken(`${header}.${forged}.${signature}`, SECRET)).resolves.toBeNull();

    const flipped = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    await expect(verifyDeviceToken(`${header}.${payload}.${flipped}`, SECRET)).resolves.toBeNull();
    await expect(verifyDeviceToken(`${header}.${payload}.`, SECRET)).resolves.toBeNull();
  });

  it('rejects a token signed with another secret or algorithm', async () => {
    const otherSecret = await createDeviceToken(DEVICE, 'another-secret-0123456789abcdefghijkl');
    await expect(verifyDeviceToken(otherSecret, SECRET)).resolves.toBeNull();

    const hs512 = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(DEVICE)
      .sign(key);
    await expect(verifyDeviceToken(hs512, SECRET)).resolves.toBeNull();

    const unsigned = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub: DEVICE })}.`;
    await expect(verifyDeviceToken(unsigned, SECRET)).resolves.toBeNull();
  });

  it('rejects missing and malformed cookies', async () => {
    for (const value of [undefined, '', 'garbage', 'a.b.c', DEVICE]) {
      await expect(verifyDeviceToken(value, SECRET)).resolves.toBeNull();
    }
  });

  it('only accepts a uuid as the subject', async () => {
    for (const subject of ['not-a-uuid', `${DEVICE}0`, '', '0f8fad5b-d9cb-469f-a165-70867728950']) {
      await expect(
        verifyDeviceToken(await createDeviceToken(subject, SECRET), SECRET),
      ).resolves.toBeNull();
    }
    const noSubject = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).sign(key);
    await expect(verifyDeviceToken(noSubject, SECRET)).resolves.toBeNull();
  });

  it('is httpOnly, Lax, scoped to /t, kept a year, and Secure only on https', () => {
    expect(DEVICE_COOKIE).toBe('cid');
    expect(deviceCookieOptions('https://app.example.com')).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/t',
      maxAge: 60 * 60 * 24 * 365,
    });
    expect(deviceCookieOptions('http://localhost:3000')).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/t',
      maxAge: 31_536_000,
    });
    expect(deviceCookieOptions('http://192.168.1.20:3000').secure).toBe(false);
  });
});

// ─── Cart ───────────────────────────────────────────────────────────────────

describe('cart limits (spec §8.5)', () => {
  it('match the database', () => {
    expect(MAX_ORDER_LINES).toBe(30);
    expect(MAX_LINE_QUANTITY).toBe(20);
    expect(MAX_LINE_NOTE).toBe(120);
    expect(MAX_ORDER_NOTE).toBe(200);
  });
});

describe('adding to the cart (spec §13.1)', () => {
  it('adds a dish as a new line without touching the old cart', () => {
    expect(addToCart(EMPTY_CART, paneer)).toEqual(cartOf([cartLine(paneer, 1, '')]));
    expect(EMPTY_CART).toEqual({ lines: [], note: '' });
  });

  it('merges the same dish and option into one line', () => {
    let cart = addToCart(EMPTY_CART, paneer)!;
    cart = addToCart(cart, paneer, 2)!;
    cart = addToCart(cart, chickenFull)!;
    cart = addToCart(cart, chickenHalf, 3)!;
    cart = addToCart(cart, chickenFull)!;
    expect(cart.lines.map((line) => [lineKey(line), line.quantity])).toEqual([
      [`${PANEER}:`, 3],
      [`${BUTTER_CHICKEN}:${FULL}`, 2],
      [`${BUTTER_CHICKEN}:${HALF}`, 3],
    ]);
  });

  it('keeps the order note', () => {
    const cart = addToCart(cartOf([], 'No onions'), paneer);
    expect(cart?.note).toBe('No onions');
  });

  it('keeps a line note unless a new one is given', () => {
    const noted = addToCart(EMPTY_CART, paneer, 1, '  less spicy  ')!;
    expect(noted.lines[0].note).toBe('less spicy');
    expect(addToCart(noted, paneer)!.lines[0].note).toBe('less spicy');
    expect(addToCart(noted, paneer, 1, '   ')!.lines[0].note).toBe('less spicy');
    expect(addToCart(noted, paneer, 1, ' no onion ')!.lines[0].note).toBe('no onion');
  });

  it('cuts line notes to 120 characters', () => {
    expect(addToCart(EMPTY_CART, paneer, 1, `  ${'x'.repeat(130)}`)!.lines[0].note).toBe(
      'x'.repeat(120),
    );
    const noted = addToCart(EMPTY_CART, paneer, 1, 'less spicy')!;
    expect(addToCart(noted, paneer, 1, 'y'.repeat(130))!.lines[0].note).toBe('y'.repeat(120));
  });

  it('caps a line at 20 and never adds fewer than one', () => {
    expect(addToCart(EMPTY_CART, paneer, 25)!.lines[0].quantity).toBe(20);
    const fifteen = addToCart(EMPTY_CART, paneer, 15)!;
    expect(addToCart(fifteen, paneer, 10)!.lines[0].quantity).toBe(20);
    expect(addToCart(EMPTY_CART, paneer, 0)!.lines[0].quantity).toBe(1);
    expect(addToCart(EMPTY_CART, paneer, 2.9)!.lines[0].quantity).toBe(2);
  });

  it('refuses a 31st line but still tops up existing ones', () => {
    const full = filledCart(30);
    expect(full.lines).toHaveLength(30);
    expect(addToCart(full, paneer)).toBeNull();

    const topped = addToCart(full, dish(7), 2);
    expect(topped?.lines).toHaveLength(30);
    expect(topped?.lines[6].quantity).toBe(3);

    expect(addToCart(filledCart(29), paneer)?.lines).toHaveLength(30);
  });
});

describe('editing the cart', () => {
  const cart = cartOf(
    [cartLine(paneer, 2), cartLine(chickenFull, 1, 'extra gravy'), cartLine(chickenHalf)],
    'No onions',
  );

  it('sets a quantity, capped at 20', () => {
    expect(setLineQuantity(cart, lineKey(paneer), 5)).toEqual(
      cartOf(
        [cartLine(paneer, 5), cartLine(chickenFull, 1, 'extra gravy'), cartLine(chickenHalf)],
        'No onions',
      ),
    );
    expect(setLineQuantity(cart, lineKey(paneer), 25).lines[0].quantity).toBe(20);
    expect(setLineQuantity(cart, lineKey(paneer), 3.7).lines[0].quantity).toBe(3);
  });

  it('removes a line at 0 (or below), and only that option', () => {
    expect(setLineQuantity(cart, lineKey(chickenFull), 0)).toEqual(
      cartOf([cartLine(paneer, 2), cartLine(chickenHalf)], 'No onions'),
    );
    expect(setLineQuantity(cart, lineKey(paneer), -1).lines.map(lineKey)).toEqual([
      lineKey(chickenFull),
      lineKey(chickenHalf),
    ]);
  });

  it('ignores a line that is not in the cart', () => {
    expect(setLineQuantity(cart, `${DAL}:`, 4)).toEqual(cart);
    expect(setLineNote(cart, `${DAL}:`, 'hello')).toEqual(cart);
  });

  it('limits line notes to 120 and the order note to 200 characters', () => {
    const noted = setLineNote(cart, lineKey(paneer), 'z'.repeat(150));
    expect(noted.lines.map((line) => line.note)).toEqual(['z'.repeat(120), 'extra gravy', '']);
    expect(setLineNote(cart, lineKey(chickenFull), '').lines[1].note).toBe('');

    expect(setOrderNote(cart, 'n'.repeat(250)).note).toBe('n'.repeat(200));
    expect(setOrderNote(cart, 'Birthday, bring a candle')).toEqual({
      ...cart,
      note: 'Birthday, bring a candle',
    });
  });

  it('counts dishes and adds up the estimate', () => {
    const counted = cartOf([cartLine(paneer, 2), cartLine(chickenFull), cartLine(chickenHalf, 3)]);
    expect(cartCount(counted)).toBe(6);
    expect(cartTotalPaise(counted)).toBe(2 * 28000 + 42000 + 3 * 24000);
    expect(itemQuantity(counted, BUTTER_CHICKEN)).toBe(4);
    expect(itemQuantity(counted, PANEER)).toBe(2);
    expect(itemQuantity(counted, DAL)).toBe(0);
    expect(cartCount(EMPTY_CART)).toBe(0);
    expect(cartTotalPaise(EMPTY_CART)).toBe(0);
  });
});

describe('cart against the current menu', () => {
  it('keeps what is still on the menu and refreshes names and prices', () => {
    const stale = cartOf(
      [
        cartLine(
          { ...paneer, name: 'Paneer Tika', foodType: 'egg', unitPricePaise: 25000 },
          2,
          'less spicy',
        ),
        cartLine({ ...chickenFull, variantName: 'Large', unitPricePaise: 40000 }, 3),
      ],
      'No onions',
    );
    expect(reconcileCart(stale, MENU)).toEqual({
      cart: cartOf([cartLine(paneer, 2, 'less spicy'), cartLine(chickenFull, 3)], 'No onions'),
      removed: [],
    });
  });

  it('drops dishes that are out of stock and names them', () => {
    const cart = cartOf([cartLine(paneer), cartLine(chickenFull)]);
    expect(reconcileCart(cart, withItem(PANEER, { isAvailable: false }))).toEqual({
      cart: cartOf([cartLine(chickenFull)]),
      removed: ['Paneer Tikka'],
    });
  });

  it('drops dishes that left the menu', () => {
    const cart = cartOf([cartLine(paneer), cartLine(chickenFull, 2)], 'No onions');
    const withoutPaneer = MENU.map((category) => ({
      ...category,
      items: category.items.filter((item) => item.id !== PANEER),
    }));
    expect(reconcileCart(cart, withoutPaneer)).toEqual({
      cart: cartOf([cartLine(chickenFull, 2)], 'No onions'),
      removed: ['Paneer Tikka'],
    });
    expect(reconcileCart(cart, [])).toEqual({
      cart: cartOf([], 'No onions'),
      removed: ['Paneer Tikka', 'Butter Chicken (Full)'],
    });
  });

  it('drops a line whose option was removed', () => {
    const cart = cartOf([cartLine(chickenFull), cartLine(chickenHalf)]);
    const menu = withItem(BUTTER_CHICKEN, {
      variants: [{ id: HALF, name: 'Half', pricePaise: 24000 }],
    });
    expect(reconcileCart(cart, menu)).toEqual({
      cart: cartOf([cartLine(chickenHalf)]),
      removed: ['Butter Chicken (Full)'],
    });
  });

  it('drops a plain line when the dish gained options, and an option line when it lost them', () => {
    const gained = withItem(PANEER, {
      variants: [{ id: LARGE, name: 'Large', pricePaise: 35000 }],
    });
    expect(reconcileCart(cartOf([cartLine(paneer)]), gained)).toEqual({
      cart: cartOf([]),
      removed: ['Paneer Tikka'],
    });

    const lost = withItem(BUTTER_CHICKEN, { variants: [] });
    expect(reconcileCart(cartOf([cartLine(chickenFull)]), lost)).toEqual({
      cart: cartOf([]),
      removed: ['Butter Chicken (Full)'],
    });
  });

  it('removes the lines the database refused, found by what was sent', () => {
    const cart = cartOf(
      [cartLine(paneer), cartLine(chickenFull), cartLine(chickenHalf, 2)],
      'No onions',
    );
    const keys = refusedKeys(cart.lines, [1, 2, 7]);
    expect(removeLines(cart, keys)).toEqual({
      cart: cartOf([cartLine(paneer)], 'No onions'),
      removed: ['Butter Chicken (Full)', 'Butter Chicken (Half)'],
    });
    expect(removeLines(cart, [])).toEqual({ cart, removed: [] });
    // The cart changed meanwhile (another tab): only lines still there go.
    expect(removeLines(cartOf([cartLine(paneer)]), keys)).toEqual({
      cart: cartOf([cartLine(paneer)]),
      removed: [],
    });
  });
});

describe('order lines', () => {
  it('send ids, quantities and trimmed notes, blank notes as null', () => {
    const cart = cartOf([
      cartLine(paneer, 2, '  less spicy  '),
      cartLine(chickenFull, 1, '   '),
      cartLine(chickenHalf, 3, ''),
    ]);
    expect(toOrderLines(cart)).toEqual([
      { menuItemId: PANEER, variantId: null, quantity: 2, note: 'less spicy' },
      { menuItemId: BUTTER_CHICKEN, variantId: FULL, quantity: 1, note: null },
      { menuItemId: BUTTER_CHICKEN, variantId: HALF, quantity: 3, note: null },
    ]);
  });

  it('from a cart at every limit still pass the server check', () => {
    let cart = filledCart(30);
    for (const line of cart.lines) {
      cart = setLineQuantity(cart, lineKey(line), 99);
      cart = setLineNote(cart, lineKey(line), 'n'.repeat(500));
    }
    cart = setOrderNote(cart, 'o'.repeat(500));
    const result = placeOrderSchema.safeParse({
      idempotencyKey: randomUuid(),
      lines: toOrderLines(cart),
      note: cart.note,
    });
    expect(result.success).toBe(true);
    expect(result.data?.lines).toHaveLength(30);
    expect(result.data?.lines.every((line) => line.quantity === 20)).toBe(true);
  });
});

describe('stored cart', () => {
  const stored = (value: unknown) => JSON.stringify(value);
  const valid = cartLine(paneer, 2, 'less spicy');

  it('round-trips through localStorage', () => {
    const cart = cartOf([valid, cartLine(chickenFull, 20)], 'No onions');
    const raw = serializeCart(cart);
    expect(JSON.parse(raw)).toMatchObject({ v: 1 });
    expect(parseStoredCart(raw)).toEqual(cart);
    expect(parseStoredCart(serializeCart(EMPTY_CART))).toEqual(EMPTY_CART);
  });

  it('starts empty on missing, broken or old data', () => {
    for (const raw of [
      null,
      '',
      '{not json',
      'null',
      '42',
      '[]',
      stored({ v: 2, lines: [valid], note: 'x' }),
      stored({ lines: [valid], note: 'x' }),
      stored({ v: '1', lines: [valid] }),
      stored({ v: 1, lines: 'nope' }),
    ]) {
      expect(parseStoredCart(raw)).toEqual(EMPTY_CART);
    }
  });

  it('drops anything that is not a cart line', () => {
    const raw = stored({
      v: 1,
      lines: [
        valid,
        null,
        'Paneer Tikka',
        { ...valid, menuItemId: 7 },
        { ...valid, variantId: undefined },
        { ...valid, variantName: 5 },
        { ...valid, name: null },
        { ...valid, foodType: 'vegan' },
        { ...valid, unitPricePaise: '280' },
        { ...valid, quantity: 0 },
        { ...valid, quantity: 21 },
        { ...valid, quantity: 1.5 },
        { ...valid, note: null },
        cartLine(chickenFull, 20),
      ],
      note: 'No onions',
    });
    expect(parseStoredCart(raw)).toEqual(cartOf([valid, cartLine(chickenFull, 20)], 'No onions'));
  });

  it('keeps at most 30 lines and a 200-character order note', () => {
    const lines = Array.from({ length: 35 }, (_, i) => cartLine(dish(i + 1)));
    const parsed = parseStoredCart(stored({ v: 1, lines, note: 'n'.repeat(250) }));
    expect(parsed.lines).toEqual(lines.slice(0, 30));
    expect(parsed.note).toBe('n'.repeat(200));
    expect(parseStoredCart(stored({ v: 1, lines: [valid], note: 42 }))).toEqual(cartOf([valid]));
  });
});

describe('idempotency keys (spec §9.3)', () => {
  it('are unique v4 uuids the server accepts', () => {
    const keys = Array.from({ length: 200 }, () => randomUuid());
    expect(new Set(keys).size).toBe(200);
    for (const key of keys) {
      expect(key).toMatch(UUID_V4);
      expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
    }
  });

  it('set the version and variant bits whatever the random bytes', () => {
    const filled =
      (byte: number) =>
      <T>(array: T): T => {
        if (array instanceof Uint8Array) array.fill(byte);
        return array;
      };
    const random = vi.spyOn(crypto, 'getRandomValues');
    random.mockImplementationOnce(filled(0xff));
    expect(randomUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    random.mockImplementationOnce(filled(0x00));
    expect(randomUuid()).toBe('00000000-0000-4000-8000-000000000000');
  });
});

// ─── Accent colour ──────────────────────────────────────────────────────────

describe('accent colour (spec §16.1, §16.2)', () => {
  const WHITE = '#FFFFFF';
  const INK = '#243040';
  const fallback = { accent: DEFAULT_ACCENT, foreground: WHITE, ring: DEFAULT_ACCENT };

  it('measures WCAG contrast either way round', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#3B4BA8', '#3B4BA8')).toBe(1);
    expect(contrastRatio('#767676', WHITE)).toBeCloseTo(4.54, 2);
  });

  it('keeps the default brand with white text', () => {
    expect(DEFAULT_ACCENT).toBe('#3B4BA8');
    expect(accentColors('#3B4BA8')).toEqual({
      accent: '#3B4BA8',
      foreground: WHITE,
      ring: '#3B4BA8',
    });
    expect(accentColors('#3b4ba8').accent).toBe('#3B4BA8');
    expect(accentColors('#2e7d32')).toEqual({
      accent: '#2E7D32',
      foreground: WHITE,
      ring: '#2E7D32',
    });
  });

  it('puts ink on light accents, with an ink focus ring', () => {
    expect(accentColors('#F5C518')).toEqual({ accent: '#F5C518', foreground: INK, ring: INK });
    expect(accentColors('#ff6b00')).toEqual({ accent: '#FF6B00', foreground: INK, ring: INK });
  });

  it('falls back to the default brand when neither text colour is readable', () => {
    expect(accentColors('#808080')).toEqual(fallback);
    expect(accentColors('#E4572E')).toEqual(fallback);
    // Dark enough for a ring, not for text.
    expect(accentColors('#00A86B')).toEqual(fallback);
  });

  it('falls back on anything that is not #rrggbb', () => {
    for (const value of ['', 'red', '#FFF', '3B4BA8', '#GGGGGG', '#3B4BA8FF', ' #3B4BA8']) {
      expect(accentColors(value)).toEqual(fallback);
    }
  });

  it('always gives 4.5:1 text and a 3:1 focus ring on white', () => {
    const steps = [0x00, 0x33, 0x66, 0x99, 0xcc, 0xff];
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
          const colors = accentColors(hex);
          expect([hex.toUpperCase(), DEFAULT_ACCENT]).toContain(colors.accent);
          expect(contrastRatio(colors.accent, colors.foreground)).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(colors.ring, WHITE)).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });
});

// ─── Display text ───────────────────────────────────────────────────────────

describe('customer display text (spec §13.1)', () => {
  it('heads numbered tables "Table 5" and shows named ones as they are', () => {
    expect(tableHeading('5')).toBe('Table 5');
    expect(tableHeading('12A')).toBe('Table 12A');
    expect(tableHeading('08')).toBe('Table 08');
    expect(tableHeading('Terrace 1')).toBe('Terrace 1');
    expect(tableHeading('T5')).toBe('T5');
  });

  it('builds the notice above "Place order"', () => {
    const within = (period: string) =>
      `After you place the order, only staff can remove items. You can cancel an item within ${period} if the kitchen hasn’t started it.`;
    expect(en.cart.cancelNotice(120)).toBe(within('2 minutes'));
    expect(en.cart.cancelNotice(90)).toBe(within('90 seconds'));
    expect(en.cart.cancelNotice(60)).toBe(within('1 minute'));
    expect(en.cart.cancelNotice(600)).toBe(within('10 minutes'));
    expect(en.cart.cancelNotice(1)).toBe(within('1 second'));
    expect(en.cart.cancelNotice(0)).toBe('After you place the order, only staff can remove items.');
    expect(en.cart.cancelNotice(-5)).toBe(
      'After you place the order, only staff can remove items.',
    );
  });

  it('shows round times in the restaurant timezone', () => {
    expect(formatClockTime('2026-09-12T14:12:00Z', 'Asia/Kolkata')).toBe('7:42 pm');
    expect(formatClockTime('2026-09-12T18:35:00Z', 'Asia/Kolkata')).toBe('12:05 am');
    expect(formatClockTime('2026-09-12T06:30:00Z', 'Asia/Kolkata')).toBe('12:00 pm');
    expect(formatClockTime('2026-09-12T14:12:00Z', 'Asia/Dubai')).toBe('6:12 pm');
  });

  it('counts down in minutes and seconds, rounding up and never below zero', () => {
    expect(formatCountdown(120_000)).toBe('2:00');
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(64_001)).toBe('1:05');
    expect(formatCountdown(59_001)).toBe('1:00');
    expect(formatCountdown(1)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-3_000)).toBe('0:00');
  });

  it('lists names', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['Paneer Tikka'])).toBe('Paneer Tikka');
    expect(listNames(['Paneer Tikka', 'Butter Chicken (Full)'])).toBe(
      'Paneer Tikka and Butter Chicken (Full)',
    );
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C');
  });

  it('says which dishes left the cart', () => {
    expect(en.unavailable(['Paneer Tikka'])).toBe(
      'Paneer Tikka is no longer available, so we removed it from your cart.',
    );
    expect(en.unavailable(['Paneer Tikka', 'Butter Chicken (Full)', 'Dal Makhani'])).toBe(
      'Paneer Tikka, Butter Chicken (Full) and Dal Makhani are no longer available, so we removed them from your cart.',
    );
  });

  it('labels new dishes "Placed" for customers', () => {
    expect(en.status.placed).toBe('Placed');
  });
});

describe('Hindi customer screens (docs/DECISIONS.md P9-7)', () => {
  it('names tables, counts and time in Hindi, keeping dish names and digits', () => {
    expect(hi.table('5')).toBe('टेबल 5');
    expect(hi.table('Terrace 1')).toBe('Terrace 1');
    expect(hi.menu.found(0)).toBe('कोई डिश नहीं मिली।');
    expect(hi.menu.found(1)).toBe('1 डिश मिली।');
    expect(hi.menu.found(3)).toBe('3 डिश मिलीं।');
    expect(hi.cart.cancelNotice(120)).toBe(
      'ऑर्डर करने के बाद सिर्फ़ स्टाफ़ ही आइटम हटा सकता है। अगर किचन ने शुरू नहीं किया है, तो आप 2 मिनट के अंदर कोई आइटम रद्द कर सकते हैं।',
    );
    expect(hi.cart.cancelNotice(90)).toContain('90 सेकंड के अंदर');
    expect(hi.cart.cancelNotice(0)).toBe('ऑर्डर करने के बाद सिर्फ़ स्टाफ़ ही आइटम हटा सकता है।');
  });

  it('joins dish names with और', () => {
    expect(hi.unavailable(['Paneer Tikka'])).toBe(
      'Paneer Tikka अब उपलब्ध नहीं है, इसलिए हमने इसे आपके कार्ट से हटा दिया है।',
    );
    expect(hi.unavailable(['A', 'B', 'C'])).toBe(
      'A, B और C अब उपलब्ध नहीं हैं, इसलिए हमने इन्हें आपके कार्ट से हटा दिया है।',
    );
  });

  it('has a Hindi message for every refusal the customer can see', () => {
    expect(Object.keys(hi.errors)).toEqual(Object.keys(en.errors));
    expect(Object.keys(hi.requestErrors)).toEqual(Object.keys(en.requestErrors));
    for (const [code, message] of Object.entries(hi.errors)) {
      expect(message, code).not.toBe(en.errors[code as keyof typeof en.errors]);
    }
  });
});

// ─── Menu search ────────────────────────────────────────────────────────────

describe('menu search and Veg only (spec §13.1)', () => {
  it('returns the menu untouched without a filter', () => {
    expect(filterMenu(MENU, '', false)).toBe(MENU);
    expect(filterMenu(MENU, '   ', false)).toBe(MENU);
  });

  it('matches dish names, dropping empty categories', () => {
    expect(itemNames(filterMenu(MENU, 'paneer', false))).toEqual([['Starters', ['Paneer Tikka']]]);
    expect(itemNames(filterMenu(MENU, 'chicken', false))).toEqual([
      ['Starters', ['Chicken 65']],
      ['Main Course', ['Butter Chicken']],
    ]);
  });

  it('matches descriptions, skipping dishes without one', () => {
    expect(itemNames(filterMenu(MENU, 'cottage', false))).toEqual([['Starters', ['Paneer Tikka']]]);
    expect(itemNames(filterMenu(MENU, 'spicy', false))).toEqual([['Starters', ['Chicken 65']]]);
  });

  it('keeps every dish of a matching category', () => {
    expect(itemNames(filterMenu(MENU, 'main', false))).toEqual([
      ['Main Course', ['Butter Chicken', 'Dal Makhani']],
    ]);
  });

  it('ignores case and extra spaces', () => {
    expect(itemNames(filterMenu(MENU, '  BUTTER   chicken ', false))).toEqual([
      ['Main Course', ['Butter Chicken']],
    ]);
    expect(itemNames(filterMenu(MENU, ' MAIN  course', false))).toEqual([
      ['Main Course', ['Butter Chicken', 'Dal Makhani']],
    ]);
  });

  it('shows only vegetarian dishes with Veg only (egg is not veg)', () => {
    expect(itemNames(filterMenu(MENU, '', true))).toEqual([
      ['Starters', ['Paneer Tikka']],
      ['Main Course', ['Dal Makhani']],
    ]);
    expect(itemNames(filterMenu(MENU, 'main', true))).toEqual([['Main Course', ['Dal Makhani']]]);
    expect(filterMenu(MENU, 'chicken', true)).toEqual([]);
  });

  it('returns nothing when nothing matches, leaving the menu as it was', () => {
    expect(filterMenu(MENU, 'biryani', false)).toEqual([]);
    expect(itemNames(MENU)).toEqual([
      ['Starters', ['Paneer Tikka', 'Chicken 65']],
      ['Main Course', ['Butter Chicken', 'Dal Makhani']],
      ['Desserts', ['Caramel Custard']],
    ]);
  });

  it('keeps unavailable dishes (shown muted) and category ids', () => {
    const menu = MENU.map((category) =>
      category.id === 'starters'
        ? {
            ...category,
            items: category.items.map((item) =>
              item.id === PANEER ? { ...item, isAvailable: false } : item,
            ),
          }
        : category,
    );
    const [starters] = filterMenu(menu, 'paneer', true);
    expect(starters.id).toBe('starters');
    expect(starters.items).toEqual([menu[0].items[0]]);
  });
});

// ─── Error messages ─────────────────────────────────────────────────────────

describe('customer error messages (spec §13.1)', () => {
  const refusal = (error: DbErrorLike) => refusalMessage(en.errors, dbErrorCode(error));
  const customer = (message: string) => refusal({ code: 'P0001', message });

  it('explain every customer code in plain words', () => {
    expect(customer('TABLE_NOT_FOUND')).toBe(
      'This QR code isn’t working any more. Please ask the staff for help.',
    );
    expect(customer('ORDERING_UNAVAILABLE')).toBe(
      'Online ordering is unavailable right now. Please order with our staff.',
    );
    expect(customer('ITEM_UNAVAILABLE')).toBe(
      'Some dishes are no longer available. We took them out of your cart.',
    );
    expect(customer('RATE_LIMITED')).toBe('Please wait a moment before ordering again.');
    expect(customer('INVALID_INPUT')).toBe(
      'Something in your order needs checking. Look over your cart and try again.',
    );
    expect(customer('NOT_FOUND')).toBe(
      'This dish is no longer on your table’s order. Refresh the page.',
    );
    expect(customer('NOT_YOUR_ITEM')).toBe('Only the phone that ordered this dish can cancel it.');
    expect(customer('ITEM_NOT_CANCELLABLE')).toBe(
      'The kitchen has already started this dish. Please ask the staff.',
    );
    expect(customer('CANCEL_WINDOW_EXPIRED')).toBe(
      'It’s too late to cancel this dish. Please ask the staff.',
    );
    expect(en.genericError).toBe('Something went wrong. Please try again.');
  });

  it('never use staff wording', () => {
    expect(customer('RESTAURANT_READ_ONLY')).toBeNull();
    expect(customer('PLAN_LIMIT_TABLES')).toBeNull();
    expect(customer('INVALID_INPUT')).not.toBe(
      dbErrorMessage({ code: 'P0001', message: 'INVALID_INPUT' }),
    );
  });

  it('leave unknown and unexpected errors unmapped', () => {
    expect(customer('SOMETHING_NEW')).toBeNull();
    expect(customer('toString')).toBeNull();
    expect(refusal({ code: '23505', message: 'RATE_LIMITED' })).toBeNull();
    expect(
      refusal({ code: '42501', message: 'permission denied for function customer_place_order' }),
    ).toBeNull();
    expect(refusal({ message: 'TypeError: fetch failed' })).toBeNull();
  });

  it('leave the staff messages as they were', () => {
    expect(dbErrorMessage({ code: 'P0001', message: 'INVALID_INPUT' })).toBe(
      'Some details are not valid. Check them and try again.',
    );
    expect(dbErrorMessage({ code: 'P0001', message: 'NOT_FOUND' })).toBe(
      'That no longer exists. Refresh the page and try again.',
    );
    expect(dbErrorMessage({ code: '42501', message: 'permission denied' })).toBe(
      "You don't have permission to do that.",
    );
    expect(dbErrorMessage({ code: 'P0001', message: 'PLAN_LIMIT_STAFF', details: ' 3 ' })).toBe(
      'Your plan allows up to 3 staff logins. Upgrade for more, or deactivate one first.',
    );
  });
});

// ─── Server-side payload check ──────────────────────────────────────────────

describe('place order payload (spec §9.3, §9.6)', () => {
  const line = { menuItemId: PANEER, variantId: null, quantity: 1, note: null };
  const order = (overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: 'abcd1234',
    lines: [line],
    note: null,
    ...overrides,
  });
  const ok = (value: unknown) => placeOrderSchema.safeParse(value).success;
  const withLine = (overrides: Record<string, unknown>) =>
    order({ lines: [{ ...line, ...overrides }] });

  it('accepts 1 to 30 lines', () => {
    expect(ok(order())).toBe(true);
    expect(ok(order({ lines: [] }))).toBe(false);
    expect(ok(order({ lines: Array.from({ length: 30 }, () => line) }))).toBe(true);
    expect(ok(order({ lines: Array.from({ length: 31 }, () => line) }))).toBe(false);
  });

  it('accepts whole quantities from 1 to 20', () => {
    for (const quantity of [1, 20]) expect(ok(withLine({ quantity }))).toBe(true);
    for (const quantity of [0, 21, 1.5, -1, '2', null]) {
      expect(ok(withLine({ quantity }))).toBe(false);
    }
  });

  it('needs uuid ids', () => {
    expect(ok(withLine({ variantId: FULL }))).toBe(true);
    expect(ok(withLine({ menuItemId: 'paneer' }))).toBe(false);
    expect(ok(withLine({ variantId: 'full' }))).toBe(false);
  });

  it('trims notes, treats blank ones as none, and limits them to 120 and 200', () => {
    const lineNote = (note: unknown) => placeOrderSchema.safeParse(withLine({ note }));
    expect(lineNote('x'.repeat(120)).success).toBe(true);
    expect(lineNote(`  ${'x'.repeat(120)}  `).data?.lines[0].note).toBe('x'.repeat(120));
    expect(lineNote('x'.repeat(121)).success).toBe(false);
    expect(lineNote('   ').data?.lines[0].note).toBeNull();

    expect(placeOrderSchema.parse(order({ note: '   ' })).note).toBeNull();
    expect(placeOrderSchema.parse(order({ note: '  Birthday  ' })).note).toBe('Birthday');
    expect(ok(order({ note: 'x'.repeat(200) }))).toBe(true);
    expect(ok(order({ note: 'x'.repeat(201) }))).toBe(false);
  });

  it('needs an idempotency key of 8 to 100 url-safe characters', () => {
    for (const key of ['abcd1234', 'a'.repeat(100), 'retry_key-01', randomUuid()]) {
      expect(ok(order({ idempotencyKey: key }))).toBe(true);
    }
    for (const key of ['abc1234', 'a'.repeat(101), 'has space1', 'slash/key1', '', undefined]) {
      expect(ok(order({ idempotencyKey: key }))).toBe(false);
    }
  });

  it('sends only ids, quantities and notes to the database, never prices', () => {
    const parsed = placeOrderSchema.parse({
      idempotencyKey: 'retry_key-0001',
      lines: [
        {
          menuItemId: PANEER,
          variantId: null,
          quantity: 2,
          note: '  less spicy  ',
          unitPricePaise: 1,
        },
        { menuItemId: BUTTER_CHICKEN, variantId: FULL, quantity: 20, note: '   ' },
        { menuItemId: DAL, variantId: null, quantity: 1 },
      ],
    });
    expect(toOrderItemsPayload(parsed.lines)).toEqual([
      { menu_item_id: PANEER, variant_id: null, quantity: 2, note: 'less spicy' },
      { menu_item_id: BUTTER_CHICKEN, variant_id: FULL, quantity: 20, note: null },
      { menu_item_id: DAL, variant_id: null, quantity: 1, note: null },
    ]);
  });

  it('checks the QR token shape', () => {
    expect(qrTokenSchema.safeParse('DEMO0000TABLE001').success).toBe(true);
    expect(qrTokenSchema.safeParse('abcdEFGH12345678').success).toBe(true);
    for (const token of [
      'DEMO0000TABLE00',
      'DEMO0000TABLE0011',
      'DEMO0000TABLE00-',
      'DEMO0000TABLE00 ',
      '',
      42,
    ]) {
      expect(qrTokenSchema.safeParse(token).success).toBe(false);
    }
  });
});

describe('customerThemeCss', () => {
  it('puts the accent on :root so portalled sheets and dialogs inherit it', () => {
    const css = customerThemeCss(accentColors('#b42318'));
    expect(css).toContain(':root{--brand:#B42318;');
    expect(css).toContain('--primary:#B42318;--primary-foreground:#FFFFFF;--ring:#B42318}');
  });

  it('draws focus as a full-strength outline in the ring colour', () => {
    expect(customerThemeCss(accentColors('#F5C518'))).toContain(
      ':focus-visible{outline:2px solid var(--ring);outline-offset:2px}',
    );
  });

  it('only ever contains validated colours', () => {
    const css = customerThemeCss(accentColors('red;}body{display:none'));
    expect(css).not.toContain('display:none');
    expect(css).toContain(`--brand:${DEFAULT_ACCENT}`);
  });
});

describe('countItems', () => {
  it('counts dishes across categories', () => {
    const dish = { variants: [] } as unknown as CustomerMenuItem;
    const menu = [
      { id: 'a', name: 'A', items: [dish, dish] },
      { id: 'b', name: 'B', items: [dish] },
    ] as CustomerCategory[];
    expect(countItems(menu)).toBe(3);
    expect(countItems([])).toBe(0);
  });
});
