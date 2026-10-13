import 'server-only';

import { cache } from 'react';

import { setupFeeDiscountPaise } from '@/features/platform/setup-fee';
import { createAdminClient } from '@/lib/supabase/admin';

import { toPricingPlan, type SitePricing } from './pricing';

/** Trials start on this plan (platform_create_restaurant's default, spec §14.1). */
const TRIAL_PLAN_CODE = 'growth';

/**
 * Active plans, the trial length and the setup fee for the public pages.
 * Visitors are signed out and `anon` reads no table, so the service-role
 * client reads these few columns (docs/DECISIONS.md W-5).
 */
export const getSitePricing = cache(async (): Promise<SitePricing> => {
  const admin = createAdminClient();
  const [plans, settings] = await Promise.all([
    admin
      .from('plans')
      .select(
        'code, name, price_monthly_paise, price_yearly_paise, max_tables, max_staff, features',
      )
      .eq('is_active', true)
      .order('sort_order'),
    admin
      .from('platform_settings')
      .select('trial_days, setup_fee_paise, setup_fee_discount_paise, setup_fee_discount_ends_at')
      .eq('id', 1)
      .single(),
  ]);
  if (plans.error) throw new Error(`Could not load plans: ${plans.error.message}`);
  if (settings.error)
    throw new Error(`Could not load platform settings: ${settings.error.message}`);
  return {
    plans: plans.data.map(toPricingPlan),
    trialDays: settings.data.trial_days,
    trialPlanCode: TRIAL_PLAN_CODE,
    setupFeePaise: settings.data.setup_fee_paise,
    setupFeeDiscountPaise: setupFeeDiscountPaise(settings.data),
  };
});
