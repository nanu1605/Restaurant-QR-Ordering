import { splitGst } from '@/features/subscriptions/gst';

import type { LinkDefaults } from './components/restaurant-actions';
import type { DuesRow, Plan } from './platform';

/**
 * What the Send payment link dialog suggests for a restaurant on Dues or Home:
 * its plan's prices, or for its cycle what Dues asks for (a deal's price,
 * docs/DECISIONS.md SA-80), and the setup fee as it stands. Null for every row
 * while the Razorpay keys aren't set.
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
