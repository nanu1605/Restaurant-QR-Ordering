import { describe, expect, it } from 'vitest';

import {
  canChoose,
  groupRule,
  hasChoices,
  lineFits,
  refusedLines,
  selectionError,
} from '@/features/ordering/addons';
import {
  addToCart,
  cartLineFor,
  EMPTY_CART,
  lineKey,
  parseStoredCart,
  reconcileCart,
  serializeCart,
  toOrderLines,
  type Cart,
  type CartLine,
} from '@/features/ordering/cart';
import { dishName } from '@/features/ordering/format';
import { toOrderItemsPayload } from '@/features/ordering/schemas';
import type {
  CustomerAddonGroup,
  CustomerCategory,
  CustomerMenuItem,
} from '@/features/ordering/types';

// Add-ons (docs/DECISIONS.md P9-4): the rules the options sheet and the cart
// share with the database, and carts saved before add-ons.

const PIZZA = '11111111-1111-4111-8111-111111111111';
const LARGE = '22222222-2222-4222-8222-222222222222';
const THIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const BURST = 'aaaaaaaa-0000-4000-8000-000000000002';
const OLIVES = 'cccccccc-0000-4000-8000-000000000001';
const JALAPENO = 'bbbbbbbb-0000-4000-8000-000000000002';
const ONION = 'bbbbbbbb-0000-4000-8000-000000000003';

const CRUST: CustomerAddonGroup = {
  id: 'crust',
  name: 'Crust',
  minSelect: 1,
  maxSelect: 1,
  addons: [
    { id: THIN, name: 'Thin', pricePaise: 0, isAvailable: true },
    { id: BURST, name: 'Cheese burst', pricePaise: 8000, isAvailable: true },
  ],
};
const TOPPINGS: CustomerAddonGroup = {
  id: 'toppings',
  name: 'Toppings',
  minSelect: 0,
  maxSelect: 2,
  addons: [
    { id: OLIVES, name: 'Olives', pricePaise: 3000, isAvailable: true },
    { id: JALAPENO, name: 'Jalapeño', pricePaise: 4000, isAvailable: true },
    { id: ONION, name: 'Onion', pricePaise: 2000, isAvailable: false },
  ],
};

const pizza: CustomerMenuItem = {
  id: PIZZA,
  name: 'Pizza',
  description: null,
  foodType: 'veg',
  pricePaise: 20000,
  imageUrl: null,
  isAvailable: true,
  variants: [{ id: LARGE, name: 'Large', pricePaise: 30000 }],
  addonGroups: [CRUST, TOPPINGS],
};

const menuWith = (item: CustomerMenuItem): CustomerCategory[] => [
  { id: 'mains', name: 'Mains', items: [item] },
];
const line = (ids: string[], quantity = 1): CartLine => ({
  ...cartLineFor(pizza, LARGE, ids),
  quantity,
  note: '',
});
const cartOf = (...lines: CartLine[]): Cart => ({ lines, note: '' });

describe('add-on rules', () => {
  it('describe each group for customers', () => {
    expect(groupRule({ minSelect: 0, maxSelect: 1 })).toBe('Optional');
    expect(groupRule({ minSelect: 0, maxSelect: 3 })).toBe('Optional, up to 3');
    expect(groupRule({ minSelect: 1, maxSelect: 1 })).toBe('Choose 1');
    expect(groupRule({ minSelect: 2, maxSelect: 3 })).toBe('Choose 2 to 3');
  });

  it('say what is missing or too much, like the database', () => {
    expect(selectionError(pizza.addonGroups, [])).toBe('Choose 1 from Crust.');
    expect(selectionError(pizza.addonGroups, [THIN, BURST])).toBe('Choose up to 1 from Crust.');
    expect(selectionError(pizza.addonGroups, [THIN, OLIVES, JALAPENO])).toBeNull();
    expect(selectionError([{ ...TOPPINGS, minSelect: 2, maxSelect: 3 }], [OLIVES])).toBe(
      'Choose at least 2 from Toppings.',
    );
    expect(selectionError(pizza.addonGroups, [THIN, ONION])).toBe(
      'A choice is no longer available.',
    );
    expect(selectionError([TOPPINGS], [THIN])).toBe('A choice is no longer available.');
    expect(selectionError([], [])).toBeNull();
  });

  it('make a dish unorderable when a required group has nothing in stock', () => {
    expect(canChoose(CRUST)).toBe(true);
    expect(
      canChoose({ ...CRUST, addons: CRUST.addons.map((a) => ({ ...a, isAvailable: false })) }),
    ).toBe(false);
    expect(canChoose({ ...TOPPINGS, addons: [] })).toBe(true);
  });

  it('open the options sheet for options or add-ons', () => {
    expect(hasChoices(pizza)).toBe(true);
    expect(hasChoices({ variants: [], addonGroups: [TOPPINGS] })).toBe(true);
    expect(hasChoices({ variants: [], addonGroups: [] })).toBe(false);
  });
});

describe('cart lines with add-ons', () => {
  it('add the add-on prices, sort the ids and name them in menu order', () => {
    expect(cartLineFor(pizza, LARGE, [OLIVES, BURST])).toEqual({
      menuItemId: PIZZA,
      variantId: LARGE,
      name: 'Pizza',
      variantName: 'Large',
      addonIds: [BURST, OLIVES].sort(),
      addonNames: ['Cheese burst', 'Olives'],
      foodType: 'veg',
      unitPricePaise: 41000,
    });
    expect(cartLineFor({ ...pizza, variants: [], addonGroups: [] }, null)).not.toHaveProperty(
      'addonIds',
    );
  });

  it('merge the same choices and keep different ones apart', () => {
    let cart = addToCart(EMPTY_CART, cartLineFor(pizza, LARGE, [THIN, OLIVES]))!;
    cart = addToCart(cart, cartLineFor(pizza, LARGE, [OLIVES, THIN]))!;
    cart = addToCart(cart, cartLineFor(pizza, LARGE, [BURST]))!;
    expect(cart.lines.map((l) => [l.addonNames, l.quantity])).toEqual([
      [['Thin', 'Olives'], 2],
      [['Cheese burst'], 1],
    ]);
  });

  it('keep the old key for lines without add-ons, so saved carts still match', () => {
    expect(lineKey({ menuItemId: PIZZA, variantId: LARGE })).toBe(`${PIZZA}:${LARGE}`);
    expect(lineKey({ menuItemId: PIZZA, variantId: null, addonIds: [] })).toBe(`${PIZZA}:`);
    expect(lineKey({ menuItemId: PIZZA, variantId: null, addonIds: [THIN] })).toBe(
      `${PIZZA}::${THIN}`,
    );
  });

  it('are named with their add-ons', () => {
    expect(dishName({ name: 'Pizza', variant: 'Large', addons: ['Thin', 'Olives'] })).toBe(
      'Pizza (Large) + Thin, Olives',
    );
    expect(dishName({ name: 'Garlic Bread', variant: null, addons: [] })).toBe('Garlic Bread');
    expect(dishName({ name: 'Garlic Bread', variant: null })).toBe('Garlic Bread');
  });

  it('are re-priced from the menu and dropped when their choices no longer fit', () => {
    const cart = cartOf(line([THIN, OLIVES], 2), line([BURST]));
    const pricier: CustomerMenuItem = {
      ...pizza,
      addonGroups: [
        CRUST,
        { ...TOPPINGS, addons: TOPPINGS.addons.map((a) => ({ ...a, pricePaise: 5000 })) },
      ],
    };
    expect(reconcileCart(cart, menuWith(pricier)).cart.lines.map((l) => l.unitPricePaise)).toEqual([
      35000, 38000,
    ]);

    const oliveGone: CustomerMenuItem = {
      ...pizza,
      addonGroups: [
        CRUST,
        {
          ...TOPPINGS,
          addons: TOPPINGS.addons.map((a) => ({ ...a, isAvailable: a.id !== OLIVES })),
        },
      ],
    };
    expect(reconcileCart(cart, menuWith(oliveGone))).toEqual({
      cart: cartOf(line([BURST])),
      removed: ['Pizza (Large) + Thin, Olives'],
    });

    const crustRequiredTwice: CustomerMenuItem = {
      ...pizza,
      addonGroups: [{ ...CRUST, minSelect: 2, maxSelect: 2 }, TOPPINGS],
    };
    expect(reconcileCart(cart, menuWith(crustRequiredTwice)).removed).toHaveLength(2);
  });

  it('go to the server as addon_ids, and only when there are some', () => {
    const cart = cartOf(line([OLIVES, THIN]), {
      ...cartLineFor({ ...pizza, addonGroups: [] }, LARGE),
      quantity: 1,
      note: '',
    });
    const lines = toOrderLines(cart);
    expect(lines[0]).toMatchObject({ addonIds: [THIN, OLIVES].sort() });
    expect(lines[1]).not.toHaveProperty('addonIds');
    expect(toOrderItemsPayload(lines.map((l) => ({ ...l, note: l.note ?? null })))).toEqual([
      {
        menu_item_id: PIZZA,
        variant_id: LARGE,
        quantity: 1,
        note: null,
        addon_ids: [THIN, OLIVES].sort(),
      },
      { menu_item_id: PIZZA, variant_id: LARGE, quantity: 1, note: null },
    ]);
  });
});

describe('lines the database refused', () => {
  const plain = { ...pizza, id: 'garlic-bread', variants: [], addonGroups: [TOPPINGS] };
  const menu: CustomerCategory[] = [{ id: 'mains', name: 'Mains', items: [pizza, plain] }];
  const sent = [
    { menuItemId: 'garlic-bread', variantId: null },
    { menuItemId: 'garlic-bread', variantId: null, addonIds: [OLIVES] },
    { menuItemId: PIZZA, variantId: LARGE, addonIds: [THIN] },
  ];

  it('fit when the dish, option and add-ons are all still on offer', () => {
    expect(lineFits(pizza, LARGE, [THIN])).toBe(true);
    expect(lineFits(pizza, LARGE, [])).toBe(false);
    expect(lineFits(pizza, null, [THIN])).toBe(false);
    expect(lineFits({ ...pizza, isAvailable: false }, LARGE, [THIN])).toBe(false);
    expect(lineFits(undefined, null)).toBe(false);
  });

  it('are only the lines of a refused dish that the fresh menu no longer takes', () => {
    const oliveGone: CustomerCategory[] = [
      {
        ...menu[0]!,
        items: [
          pizza,
          {
            ...plain,
            addonGroups: [
              {
                ...TOPPINGS,
                addons: TOPPINGS.addons.map((a) => ({ ...a, isAvailable: a.id !== OLIVES })),
              },
            ],
          },
        ],
      },
    ];
    expect(refusedLines(oliveGone, sent, ['garlic-bread'])).toEqual([1]);
  });

  it('are every line of the dish when the menu can’t tell which', () => {
    expect(refusedLines(menu, sent, ['garlic-bread'])).toEqual([0, 1]);
    expect(refusedLines([], sent, ['garlic-bread', PIZZA, PIZZA])).toEqual([0, 1, 2]);
    expect(refusedLines(menu, sent, [])).toEqual([]);
  });
});

describe('stored carts with add-ons', () => {
  it('round-trip, and carts saved before add-ons still load', () => {
    const cart = cartOf(line([THIN, OLIVES], 3));
    expect(parseStoredCart(serializeCart(cart))).toEqual(cart);

    const old = {
      menuItemId: PIZZA,
      variantId: LARGE,
      name: 'Pizza',
      variantName: 'Large',
      foodType: 'veg',
      unitPricePaise: 30000,
      quantity: 1,
      note: '',
    };
    expect(parseStoredCart(JSON.stringify({ v: 1, lines: [old], note: '' })).lines).toEqual([old]);
  });

  it('drop lines with add-ons that are not lists of text', () => {
    const bad = { ...line([THIN]), addonIds: [1, 2] };
    const worse = { ...line([THIN]), addonNames: 'Thin' };
    expect(parseStoredCart(JSON.stringify({ v: 1, lines: [bad, worse], note: '' })).lines).toEqual(
      [],
    );
  });
});
