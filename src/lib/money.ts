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

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]!;
  return [TENS[Math.trunc(n / 10)], ONES[n % 10]].filter(Boolean).join(' ');
}

function belowThousand(n: number): string {
  const hundreds = Math.trunc(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? belowHundred(rest) : '']
    .filter(Boolean)
    .join(' ');
}

/** Indian numbering in words: 12345678 → "One Crore Twenty Three Lakh …". */
function indianWords(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.trunc(n / 10_000_000);
  const lakh = Math.trunc((n % 10_000_000) / 100_000);
  const thousand = Math.trunc((n % 100_000) / 1_000);
  const rest = n % 1_000;
  return [
    crore ? `${indianWords(crore)} Crore` : '',
    lakh ? `${belowHundred(lakh)} Lakh` : '',
    thousand ? `${belowHundred(thousand)} Thousand` : '',
    rest ? belowThousand(rest) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The amount printed in words on bills (spec §11.3), Indian numbering:
 * 66200 → "Rupees Six Hundred Sixty Two Only".
 */
export function amountInWords(paise: Paise): string {
  assertPaise(paise);
  if (paise < 0) throw new TypeError(`amountInWords needs a non-negative amount, got ${paise}`);
  const rupees = Math.trunc(paise / 100);
  const fraction = paise % 100;
  const paiseWords = fraction ? ` and ${belowHundred(fraction)} Paise` : '';
  return `Rupees ${indianWords(rupees)}${paiseWords} Only`;
}
