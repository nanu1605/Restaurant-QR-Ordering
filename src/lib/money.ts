import { DEFAULT_LOCALE } from '@/lib/config';

/**
 * Money is always an integer number of paise (₹1 = 100 paise). Never do
 * arithmetic on rupee floats; convert to rupees only when formatting.
 */
export type Paise = number;

export function isPaise(value: unknown): value is Paise {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertPaise(value: unknown, label = 'amount'): asserts value is Paise {
  if (!isPaise(value)) {
    throw new TypeError(`${label} must be an integer number of paise, got ${String(value)}`);
  }
}

/** 66200 → "662.00", -42 → "-0.42". Exact: built from digits, not division. */
export function paiseToDecimalString(paise: Paise): string {
  assertPaise(paise);
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  return `${sign}${rupees}.${fraction}`;
}

const RUPEE_PATTERN = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a rupee amount with at most two decimals into paise.
 * "280" → 28000, "280.5" → 28050, 99.99 → 9999. Throws on anything else.
 */
export function rupeesToPaise(rupees: number | string): Paise {
  const text = typeof rupees === 'number' ? String(rupees) : rupees.trim();
  const match = RUPEE_PATTERN.exec(text);
  if (!match) {
    throw new TypeError(`Invalid rupee amount: ${String(rupees)}`);
  }
  const [, minus, whole, fraction = ''] = match;
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  assertPaise(paise);
  return minus ? -paise : paise;
}

export type FormatINROptions = {
  /** `always` → ₹620.00; `auto` → ₹620, but ₹620.50 when there are paise. */
  fraction?: 'always' | 'auto';
  /** `exceptZero` shows "+₹0.50" — used for round-off lines. */
  signDisplay?: 'auto' | 'exceptZero';
};

const formatters = new Map<string, Intl.NumberFormat>();

function getFormatter(fractionDigits: 0 | 2, signDisplay: 'auto' | 'exceptZero') {
  const key = `${fractionDigits}:${signDisplay}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
      signDisplay,
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

/** Formats paise as Indian rupees with en-IN grouping: 12345600 → "₹1,23,456.00". */
export function formatINR(paise: Paise, options: FormatINROptions = {}): string {
  const { fraction = 'always', signDisplay = 'auto' } = options;
  const decimal = paiseToDecimalString(paise);
  const showFraction = fraction === 'always' || paise % 100 !== 0;
  // Intl accepts exact decimal strings, so no float rounding is involved.
  return getFormatter(showFraction ? 2 : 0, signDisplay).format(
    decimal as Intl.StringNumericLiteral,
  );
}
