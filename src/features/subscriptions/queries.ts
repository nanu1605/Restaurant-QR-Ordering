import 'server-only';

import { createClient } from '@/lib/supabase/server';

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
      'status, source, billing_cycle, trial_ends_at, current_period_start, current_period_end, grace_until, cancel_at_period_end, plan:plans!inner (name, price_monthly_paise, price_yearly_paise)',
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
    graceUntil: data.grace_until,
    cancelAtPeriodEnd: data.cancel_at_period_end,
    plan: {
      name: data.plan.name,
      priceMonthlyPaise: data.plan.price_monthly_paise,
      priceYearlyPaise: data.plan.price_yearly_paise,
    },
  };
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
