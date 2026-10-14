import type { LinkDefaults } from './components/restaurant-actions';
import type { DuesRow, Plan } from './platform';

/**
 * What the Send payment link dialog suggests for a restaurant on Dues or Home:
 * its plan's prices and the setup fee as it stands. Null for every row while
 * the Razorpay keys aren't set.
 */
export function duesLinkDefaults(
  plans: Plan[],
  setupFee: { feePaise: number; discountPaise: number },
  withRazorpay: boolean,
) {
  return (row: Pick<DuesRow, 'plan_code' | 'plan_name'>): LinkDefaults | null => {
    if (!withRazorpay) return null;
    const plan = plans.find((p) => p.code === row.plan_code);
    return {
      planName: row.plan_name,
      monthlyPaise: plan?.price_monthly_paise ?? 0,
      yearlyPaise: plan?.price_yearly_paise ?? 0,
      setupFeePaise: setupFee.feePaise - setupFee.discountPaise,
      setupFeeDiscountPaise: setupFee.discountPaise,
    };
  };
}
