import { cn } from 'cn';
import { Fragment, type ReactNode } from 'react';

import { formatINR, type FormatINROptions, type Paise } from '@/lib/money';

type MoneyProps = FormatINROptions & {
  paise: Paise;
  className?: string;
};

/**
 * Draws each ₹ in `text` in the system font. Noto Sans has ₹ only in its latin-ext and
 * devanagari files, so one ₹ in our font downloads up to 260 KB more (docs/DECISIONS.md W-14).
 * In a flex box, wrap the text around it in one element, or the ₹ becomes an item of its own.
 */
export function withRupee(text: string): ReactNode {
  const [first, ...rest] = text.split('₹');
  if (!rest.length) return text;
  return (
    <>
      {first}
      {rest.map((part, index) => (
        <Fragment key={index}>
          <span className="[font-family:system-ui,sans-serif]">₹</span>
          {part}
        </Fragment>
      ))}
    </>
  );
}

/** Renders an integer paise amount as ₹ with en-IN grouping and tabular digits. */
export function Money({ paise, fraction, signDisplay, className }: MoneyProps) {
  return (
    <span className={cn('tabular-nums', className)}>
      {withRupee(formatINR(paise, { fraction, signDisplay }))}
    </span>
  );
}
