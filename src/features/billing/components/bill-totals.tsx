import { cn } from 'cn';

import { Money } from '@/components/shared/money';

import { type BillTotals, type GstMode, halfRateLabel, percentLabel } from '../bill';

type BillTotalsListProps = {
  totals: BillTotals;
  gstMode: GstMode;
  gstRateBps: number;
  serviceChargeBps: number;
  /** Shown after "Discount" (e.g. "10%" or the reason on an office copy). */
  discountNote?: string | null;
  className?: string;
  /** Classes for the grand total row. */
  grandClassName?: string;
};

/**
 * Bill totals in the order of spec §11.3: subtotal, discount, service charge
 * (optional), taxable value and CGST/SGST for GST-registered restaurants,
 * round off and the grand total.
 */
export function BillTotalsList({
  totals,
  gstMode,
  gstRateBps,
  serviceChargeBps,
  discountNote,
  className,
  grandClassName,
}: BillTotalsListProps) {
  const rows: { label: string; paise: number; sign?: boolean }[] = [
    { label: 'Subtotal', paise: totals.subtotalPaise },
  ];
  if (totals.discountPaise > 0) {
    rows.push({
      label: discountNote ? `Discount (${discountNote})` : 'Discount',
      paise: -totals.discountPaise,
    });
  }
  if (totals.serviceChargePaise > 0) {
    rows.push({
      label: `Service charge (optional) ${percentLabel(serviceChargeBps)}`,
      paise: totals.serviceChargePaise,
    });
  }
  if (gstMode === 'regular') {
    rows.push(
      { label: 'Taxable value', paise: totals.taxablePaise },
      { label: `CGST ${halfRateLabel(gstRateBps)}`, paise: totals.cgstPaise },
      { label: `SGST ${halfRateLabel(gstRateBps)}`, paise: totals.sgstPaise },
    );
  }
  if (totals.roundOffPaise !== 0) {
    rows.push({ label: 'Round off', paise: totals.roundOffPaise, sign: true });
  }

  return (
    <dl className={cn('flex flex-col gap-1', className)}>
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-3">
          <dt>{row.label}</dt>
          <dd>
            <Money paise={row.paise} signDisplay={row.sign ? 'exceptZero' : 'auto'} />
          </dd>
        </div>
      ))}
      <div className={cn('flex items-baseline justify-between gap-3 font-bold', grandClassName)}>
        <dt>Grand total</dt>
        <dd>
          <Money paise={totals.grandTotalPaise} />
        </dd>
      </div>
    </dl>
  );
}
