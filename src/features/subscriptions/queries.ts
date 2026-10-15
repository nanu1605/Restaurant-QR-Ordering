import 'server-only';

import { FEATURE_KEYS } from '@/features/plans/plan-features';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import type { BillingCycle, CheckoutPlan } from './autopay';
import { ownerPricesSchema, type OwnerPrices } from './offers';
import type { OwnerSubscription, SubscriptionPayment } from './summary';

/**
 * The owner's view of the subscription (RLS: owners of the restaurant only,
 * spec §8.11). Reads only; every change goes through the platform functions.
 */
export async function getOwnerSubscription(
  restaurantId: string,
): Promise<OwnerSubscription | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('restaurant_subscriptions')
    .select(
      'status, source, billing_cycle, trial_ends_at, current_period_start, current_period_end, cancel_at_period_end, razorpay_status, next_billing_cycle, plan:plans!restaurant_subscriptions_plan_id_fkey!inner (name, price_monthly_paise, price_yearly_paise), next_plan:plans!restaurant_subscriptions_next_plan_id_fkey (name, price_monthly_paise, price_yearly_paise)',
    )
    .eq('restaurant_id', restaurantId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the subscription: ${error.message}`);
  if (!data) return null;

  return {
    status: data.status,
    source: data.source,
    billingCycle: data.billing_cycle,
    trialEndsAt: data.trial_ends_at,
    currentPeriodStart: data.current_period_start,
    currentPeriodEnd: data.current_period_end,
    cancelAtPeriodEnd: data.cancel_at_period_end,
    razorpayStatus: data.razorpay_status,
    nextPlanName: data.next_plan?.name ?? null,
    nextBillingCycle: data.next_billing_cycle,
    nextPricePaise: data.next_plan
      ? data.next_billing_cycle === 'yearly'
        ? data.next_plan.price_yearly_paise
        : data.next_plan.price_monthly_paise
      : null,
    plan: {
      name: data.plan.name,
      priceMonthlyPaise: data.plan.price_monthly_paise,
      priceYearlyPaise: data.plan.price_yearly_paise,
    },
  };
}

/**
 * Special prices for the owner's page (docs/DECISIONS.md SA-77+): deals are
 * the team's records, so the service role reads only their prices.
 */
export async function getOwnerPrices(restaurantId: string): Promise<OwnerPrices> {
  const { data, error } = await createAdminClient().rpc('subscription_offer_preview', {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(`Could not load the prices: ${error.message}`);
  return ownerPricesSchema.parse(data);
}

/** Subscription payments, newest first. */
export async function getSubscriptionPayments(
  restaurantId: string,
): Promise<SubscriptionPayment[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('subscription_payments')
    .select('id, created_at, amount_paise, source, manual_mode, period_start, period_end')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`Could not load subscription payments: ${error.message}`);

  return data.map((row) => ({
    id: row.id,
    paidAt: row.created_at,
    amountPaise: row.amount_paise,
    source: row.source,
    manualMode: row.manual_mode,
    periodStart: row.period_start,
    periodEnd: row.period_end,
  }));
}

/** Active tables and staff logins (besides owners), the two counts plans limit. */
export async function getPlanUsage(
  restaurantId: string,
): Promise<{ tables: number; staff: number }> {
  const supabase = await createClient();
  const [tables, staff] = await Promise.all([
    supabase
      .from('dining_tables')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('is_active', true),
    supabase
      .from('restaurant_members')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('is_active', true)
      .neq('role', 'owner'),
  ]);
  if (tables.error) throw new Error(`Could not count tables: ${tables.error.message}`);
  if (staff.error) throw new Error(`Could not count staff logins: ${staff.error.message}`);
  return { tables: tables.count ?? 0, staff: staff.count ?? 0 };
}

/**
 * Active plans that can be paid online, cheapest first: those with a Razorpay
 * plan for at least one cycle (docs/DECISIONS.md P8-10).
 */
export async function getCheckoutPlans(): Promise<CheckoutPlan[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('plans')
    .select(
      'code, name, price_monthly_paise, price_yearly_paise, max_tables, max_staff, features, razorpay_plan_id_monthly, razorpay_plan_id_yearly',
    )
    .eq('is_active', true)
    .order('sort_order');
  if (error) throw new Error(`Could not load plans: ${error.message}`);

  return data.flatMap((row) => {
    const cycles: BillingCycle[] = [];
    if (row.razorpay_plan_id_monthly) cycles.push('monthly');
    if (row.razorpay_plan_id_yearly) cycles.push('yearly');
    if (cycles.length === 0) return [];
    const raw = (row.features ?? {}) as Record<string, unknown>;
    return [
      {
        code: row.code,
        name: row.name,
        monthlyPaise: row.price_monthly_paise,
        yearlyPaise: row.price_yearly_paise,
        maxTables: row.max_tables,
        maxStaff: row.max_staff,
        features: Object.fromEntries(
          FEATURE_KEYS.map((key) => [key, raw[key] === true]),
        ) as CheckoutPlan['features'],
        cycles,
      },
    ];
  });
}
