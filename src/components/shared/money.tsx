import { cn } from 'cn';

import { formatINR, type FormatINROptions, type Paise } from '@/lib/money';

type MoneyProps = FormatINROptions & {
  paise: Paise;
  className?: string;
};

/** Renders an integer paise amount as ₹ with en-IN grouping and tabular digits. */
export function Money({ paise, fraction, signDisplay, className }: MoneyProps) {
  return (
    <span className={cn('tabular-nums', className)}>
      {formatINR(paise, { fraction, signDisplay })}
    </span>
  );
}
