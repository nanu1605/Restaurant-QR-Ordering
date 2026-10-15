import { splitGst } from '@/features/subscriptions/gst';

import type { LinkDefaults } from './components/restaurant-actions';
import type { DuesRow, Plan } from './platform';

/**
 * What the Send payment link dialog suggests for a restaurant on Dues or Home:
 * its plan's prices, or for its cycle what Dues asks for (a deal's price,
 * docs/DECISIONS.md SA-80), and the setup fee as it stands. Null for every row
 * while the Razorpay keys aren't set.
 *
 * ponytail: a Dues row doesn't carry a deal's charges left, so a link for more
 * months than that suggests its price for all of them (the restaurant page
 * caps it); add the charges to dues_rows if long links from Dues are common.
 */
export function duesLinkDefaults(
  plans: Plan[],
  setupFee: { feePaise: number; discountPaise: number },
  withRazorpay: boolean,
) {
  return (
    row: Pick<DuesRow, 'plan_code' | 'plan_name'> &
      Partial<Pick<DuesRow, 'due_paise' | 'billing_cycle'>>,
  ): LinkDefaults | null => {
    if (!withRazorpay) return null;
    const plan = plans.find((p) => p.code === row.plan_code);
    const due = row.due_paise ? splitGst(row.due_paise).basePaise : null;
    const cycle = row.billing_cycle ?? 'monthly';
    return {
      planName: row.plan_name,
      monthlyPaise: (cycle === 'monthly' ? due : null) ?? plan?.price_monthly_paise ?? 0,
      yearlyPaise: (cycle === 'yearly' ? due : null) ?? plan?.price_yearly_paise ?? 0,
      setupFeePaise: setupFee.feePaise - setupFee.discountPaise,
      setupFeeDiscountPaise: setupFee.discountPaise,
    };
  };
}

/**
 * A link's plan price before GST for some months (twelve: a year): a deal's
 * price for the charges it has left, then the list price (docs/DECISIONS.md
 * SA-80).
 */
export function linkPlanPaise(
  defaults: Pick<
    LinkDefaults,
    'monthlyPaise' | 'yearlyPaise' | 'dealChargesLeft' | 'listMonthlyPaise' | 'listYearlyPaise'
  >,
  months: number,
): number {
  const yearly = months % 12 === 0;
  const charges = yearly ? months / 12 : months;
  const price = yearly ? defaults.yearlyPaise : defaults.monthlyPaise;
  const list = (yearly ? defaults.listYearlyPaise : defaults.listMonthlyPaise) ?? price;
  const atPrice = Math.min(charges, Math.max(0, defaults.dealChargesLeft ?? charges));
  return atPrice * price + (charges - atPrice) * list;
}
