import { describe, expect, it } from 'vitest';

import { assertPaise, formatINR, isPaise, paiseToDecimalString, rupeesToPaise } from '@/lib/money';

describe('formatINR', () => {
  it('uses Indian digit grouping with two decimals by default', () => {
    expect(formatINR(12345600)).toBe('₹1,23,456.00');
    expect(formatINR(1234567890)).toBe('₹1,23,45,678.90');
    expect(formatINR(66200)).toBe('₹662.00');
    expect(formatINR(0)).toBe('₹0.00');
  });

  it('formats negative amounts', () => {
    expect(formatINR(-42)).toBe('-₹0.42');
  });

  it('hides zero paise in auto mode but keeps real paise', () => {
    expect(formatINR(62000, { fraction: 'auto' })).toBe('₹620');
    expect(formatINR(62050, { fraction: 'auto' })).toBe('₹620.50');
  });

  it('shows an explicit sign for round-off lines', () => {
    expect(formatINR(50, { signDisplay: 'exceptZero' })).toBe('+₹0.50');
    expect(formatINR(-42, { signDisplay: 'exceptZero' })).toBe('-₹0.42');
    expect(formatINR(0, { signDisplay: 'exceptZero' })).toBe('₹0.00');
  });

  it('rejects non-integer amounts', () => {
    expect(() => formatINR(10.5)).toThrow(TypeError);
    expect(() => formatINR(Number.NaN)).toThrow(TypeError);
  });

  it('formats exactly at the edge of safe integers', () => {
    // 9007199254740991 paise; dividing by 100 as a float would lose the last paise.
    expect(formatINR(Number.MAX_SAFE_INTEGER)).toBe('₹9,00,71,99,25,47,409.91');
  });
});

describe('paiseToDecimalString', () => {
  it('builds the decimal from digits', () => {
    expect(paiseToDecimalString(66200)).toBe('662.00');
    expect(paiseToDecimalString(5)).toBe('0.05');
    expect(paiseToDecimalString(-42)).toBe('-0.42');
  });
});

describe('rupeesToPaise', () => {
  it('parses whole and fractional rupees', () => {
    expect(rupeesToPaise('280')).toBe(28000);
    expect(rupeesToPaise('280.5')).toBe(28050);
    expect(rupeesToPaise(' 99.99 ')).toBe(9999);
    expect(rupeesToPaise(1499)).toBe(149900);
    expect(rupeesToPaise(0.1)).toBe(10);
    expect(rupeesToPaise('-12.30')).toBe(-1230);
  });

  it('rejects anything that is not a plain rupee amount', () => {
    for (const bad of ['', '₹280', '1,499', '280.555', 'abc', '1e3', '.5']) {
      expect(() => rupeesToPaise(bad), bad).toThrow(TypeError);
    }
    expect(() => rupeesToPaise(280.555)).toThrow(TypeError);
  });
});

describe('isPaise / assertPaise', () => {
  it('accepts only safe integers', () => {
    expect(isPaise(100)).toBe(true);
    expect(isPaise(-1)).toBe(true);
    expect(isPaise(1.5)).toBe(false);
    expect(isPaise('100')).toBe(false);
    expect(() => assertPaise(1.5, 'price')).toThrow(/price must be an integer/);
  });
});
