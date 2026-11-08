// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type Cart,
  type CartLine,
  forgetOrderKey,
  ORDER_KEY_TTL_MS,
  orderKeyToSend,
  randomUuid,
} from '@/features/ordering/cart';

// The key an order is placed with is kept for a resend, also across the refresh onto a new
// build (docs/DECISIONS.md VPS-8, spec §9.3).

const TOKEN = 'AbC123dEf456gHi7';
const STORED = `tableorder:order-key:${TOKEN}`;
const NOW = 1_000_000_000;

const PANEER = '3f1c9a62-2d14-4c2c-9f3b-8d6f5a1e7b01';
const CHICKEN = '7a2e4b90-5c31-4d8e-a1f6-0b9c3d2e8f02';

const line = (menuItemId: string, quantity = 1, note = ''): CartLine => ({
  menuItemId,
  variantId: null,
  name: 'Paneer Tikka',
  variantName: null,
  foodType: 'veg',
  unitPricePaise: 28000,
  quantity,
  note,
});
const cartOf = (lines: CartLine[], note = ''): Cart => ({ lines, note });

beforeEach(() => {
  localStorage.clear();
});

describe('the key an order is placed with', () => {
  it('is the page’s own for a first order, and is kept with what was sent and when', () => {
    const own = randomUuid();
    expect(orderKeyToSend(TOKEN, cartOf([line(PANEER, 2)]), own, NOW)).toBe(own);
    expect(JSON.parse(localStorage.getItem(STORED)!)).toEqual({
      key: own,
      sent: expect.any(String),
      at: NOW,
    });
  });

  it('is the one the order was sent with when it is sent again, on a page that reloaded', () => {
    const first = randomUuid();
    const cart = cartOf([line(PANEER, 2, 'less spicy'), line(CHICKEN)], 'No onions');
    expect(orderKeyToSend(TOKEN, cart, first, NOW)).toBe(first);
    // A new page load has a new key of its own, and the cart comes back from localStorage.
    const reloaded = cartOf([line(PANEER, 2, 'less spicy'), line(CHICKEN)], 'No onions');
    expect(orderKeyToSend(TOKEN, reloaded, randomUuid(), NOW + 30_000)).toBe(first);
  });

  it('doesn’t depend on what the menu shows, only on what the server gets', () => {
    const first = randomUuid();
    orderKeyToSend(TOKEN, cartOf([line(PANEER, 2)]), first, NOW);
    // The new build renamed the dish and changed its price.
    const repriced = { ...line(PANEER, 2), name: 'Paneer Tikka Special', unitPricePaise: 30000 };
    expect(orderKeyToSend(TOKEN, cartOf([repriced]), randomUuid(), NOW + 1000)).toBe(first);
  });

  it.each<[string, Cart]>([
    ['another dish', cartOf([line(CHICKEN)])],
    ['a dish more', cartOf([line(PANEER), line(CHICKEN)])],
    ['another quantity', cartOf([line(PANEER, 3)])],
    ['another dish note', cartOf([line(PANEER, 2, 'extra spicy')])],
    ['another order note', cartOf([line(PANEER, 2)], 'Allergic to nuts')],
  ])('is a new one for %s', (_, changed) => {
    const first = randomUuid();
    orderKeyToSend(TOKEN, cartOf([line(PANEER, 2)]), first, NOW);
    const own = randomUuid();
    expect(orderKeyToSend(TOKEN, changed, own, NOW + 1000)).toBe(own);
  });

  it('is kept for ORDER_KEY_TTL_MS after the send, and is a new one from then on', () => {
    const cart = cartOf([line(PANEER)]);
    const first = randomUuid();
    orderKeyToSend(TOKEN, cart, first, NOW);
    expect(orderKeyToSend(TOKEN, cart, randomUuid(), NOW + ORDER_KEY_TTL_MS - 1)).toBe(first);

    localStorage.clear();
    orderKeyToSend(TOKEN, cart, first, NOW);
    const own = randomUuid();
    expect(orderKeyToSend(TOKEN, cart, own, NOW + ORDER_KEY_TTL_MS)).toBe(own);
  });

  it('is a new one for the same dishes ordered again later in the meal', () => {
    const cart = cartOf([line(PANEER)]);
    orderKeyToSend(TOKEN, cart, randomUuid(), NOW);
    const own = randomUuid();
    expect(orderKeyToSend(TOKEN, cart, own, NOW + 45 * 60_000)).toBe(own);
  });

  it('is kept per table', () => {
    const cart = cartOf([line(PANEER)]);
    const first = randomUuid();
    orderKeyToSend(TOKEN, cart, first, NOW);
    const own = randomUuid();
    expect(orderKeyToSend('ZzZ999yYy888xXx7', cart, own, NOW + 1000)).toBe(own);
    expect(orderKeyToSend(TOKEN, cart, randomUuid(), NOW + 2000)).toBe(first);
  });

  it('is a new one after the server has answered', () => {
    const cart = cartOf([line(PANEER)]);
    orderKeyToSend(TOKEN, cart, randomUuid(), NOW);
    forgetOrderKey(TOKEN);
    expect(localStorage.getItem(STORED)).toBeNull();
    const own = randomUuid();
    expect(orderKeyToSend(TOKEN, cart, own, NOW + 1000)).toBe(own);
  });

  it('ignores a record that is damaged, or a key the server would refuse', () => {
    const cart = cartOf([line(PANEER)]);
    const valid = { key: randomUuid(), sent: 'x', at: NOW };
    for (const raw of [
      '{',
      'null',
      '42',
      '[]',
      '{}',
      JSON.stringify({ ...valid, key: 7 }),
      JSON.stringify({ ...valid, key: 'not a key!' }),
      JSON.stringify({ ...valid, sent: null }),
      JSON.stringify({ ...valid, at: '1000' }),
      JSON.stringify({ ...valid, at: null }),
    ]) {
      localStorage.setItem(STORED, raw);
      const own = randomUuid();
      expect(orderKeyToSend(TOKEN, cart, own, NOW), raw).toBe(own);
      // And the next send starts from a good record again.
      expect(orderKeyToSend(TOKEN, cart, randomUuid(), NOW + 1000), raw).toBe(own);
    }
  });

  it('is the page’s own when storage is blocked, as before', () => {
    const blocked = () => {
      throw new DOMException('Blocked', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked);
    const own = randomUuid();
    const cart = cartOf([line(PANEER)]);
    expect(orderKeyToSend(TOKEN, cart, own, NOW)).toBe(own);
    expect(orderKeyToSend(TOKEN, cart, own, NOW + 1000)).toBe(own);
    expect(() => forgetOrderKey(TOKEN)).not.toThrow();
  });
});
