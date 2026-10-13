import 'server-only';

import { dbErrorCode } from '@/lib/db-errors';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import type { AuditFilters, RestaurantFilters, SubscriptionFilters } from './params';
import {
  parseAuditList,
  parseLookalikes,
  parseOverview,
  parseRestaurantDetail,
  parseRestaurantList,
  parseSubscriptionList,
  planSchema,
  supportRestaurantSchema,
  type SupportSection,
} from './platform';

/**
 * Super-admin reads (spec §13.4). They run as the signed-in platform admin;
 * the database checks the second factor (docs/DECISIONS.md P7-1).
 */

export async function getPlatformOverview() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_overview');
  if (error) throw new Error(`Could not load the overview: ${error.message}`);
  return parseOverview(data);
}

export async function listRestaurants(filters: RestaurantFilters) {
  const supabase = await createClient();
  const { page, ...rest } = filters;
  const { data, error } = await supabase.rpc('platform_list_restaurants', {
    p_filters: { ...rest, page },
  });
  if (error) throw new Error(`Could not load restaurants: ${error.message}`);
  return parseRestaurantList(data);
}

export async function listSubscriptions(filters: SubscriptionFilters) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_list_subscriptions', {
    p_filters: filters,
  });
  if (error) throw new Error(`Could not load subscriptions: ${error.message}`);
  return parseSubscriptionList(data);
}

/** Other restaurants that may be the same as each of these (docs/DECISIONS.md P11-13). */
export async function getLookalikes(restaurantIds: string[]) {
  if (restaurantIds.length === 0) return parseLookalikes({});
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_restaurant_lookalikes', {
    p_restaurant_ids: restaurantIds,
  });
  if (error) throw new Error(`Could not check for duplicates: ${error.message}`);
  return parseLookalikes(data);
}

/**
 * What the signup gave (P11-10, P11-12): the FSSAI licence, and a link to the
 * storefront photo that works for an hour. The photo's bucket has no storage
 * policies, so the link is signed with the service role, after the platform
 * admin's own read of the row.
 */
export async function getSignupReview(restaurantId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('restaurants')
    .select('fssai_license, storefront_photo_path')
    .eq('id', restaurantId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the signup details: ${error.message}`);
  let photoUrl: string | null = null;
  if (data?.storefront_photo_path) {
    const signed = await createAdminClient()
      .storage.from('storefront-photos')
      .createSignedUrl(data.storefront_photo_path, 60 * 60);
    if (signed.error) console.error('[platform] no link for a storefront photo', signed.error);
    photoUrl = signed.data?.signedUrl ?? null;
  }
  return { fssaiLicense: data?.fssai_license ?? null, photoUrl };
}

/** One restaurant, or null when there is no such restaurant. */
export async function getRestaurantDetail(restaurantId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_get_restaurant', {
    p_restaurant_id: restaurantId,
  });
  if (error) {
    if (dbErrorCode(error) === 'RESTAURANT_NOT_FOUND' || error.code === '22P02') return null;
    throw new Error(`Could not load the restaurant: ${error.message}`);
  }
  return parseRestaurantDetail(data);
}

/**
 * One section of a restaurant for the read-only support view, audited by the
 * database. Null when there is no such restaurant.
 */
export async function getSupportView(
  restaurantId: string,
  section: SupportSection,
  filters?: Record<string, unknown>,
) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_support_view', {
    p_restaurant_id: restaurantId,
    p_section: section,
    p_filters: (filters ?? {}) as never,
  });
  if (error) {
    if (dbErrorCode(error) === 'RESTAURANT_NOT_FOUND' || error.code === '22P02') return null;
    throw new Error(`Could not load the support view: ${error.message}`);
  }
  const result = data as { restaurant: unknown; data: unknown };
  return { restaurant: supportRestaurantSchema.parse(result.restaurant), data: result.data };
}

export async function listPlatformAudit(filters: AuditFilters) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_list_audit', { p_filters: filters });
  if (error) throw new Error(`Could not load the audit log: ${error.message}`);
  return parseAuditList(data);
}

/** Every plan, active or not, in display order. */
export async function listPlans() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('plans')
    .select(
      'id, code, name, price_monthly_paise, price_yearly_paise, razorpay_plan_id_monthly, razorpay_plan_id_yearly, max_tables, max_staff, features, is_active, sort_order',
    )
    .order('sort_order')
    .order('code');
  if (error) throw new Error(`Could not load plans: ${error.message}`);
  return planSchema.array().parse(data);
}

export const WEBHOOK_PAGE_SIZE = 50;

/** Razorpay webhooks, newest first; platform admins read them through RLS. */
export async function listWebhookEvents({
  failedOnly,
  page,
}: {
  failedOnly: boolean;
  page: number;
}) {
  const supabase = await createClient();
  const load = (at: number) => {
    const from = (at - 1) * WEBHOOK_PAGE_SIZE;
    const query = supabase
      .from('webhook_events')
      .select('id, event_id, event_type, payload, received_at, processed_at, processing_error', {
        count: 'exact',
      })
      .order('received_at', { ascending: false })
      .range(from, from + WEBHOOK_PAGE_SIZE - 1);
    return failedOnly ? query.not('processing_error', 'is', null) : query;
  };
  let current = page;
  let { data, error, count } = await load(current);
  // PostgREST refuses a page past the end (say, once reprocessing emptied it): show the first.
  if (error?.code === 'PGRST103' && current > 1) {
    current = 1;
    ({ data, error, count } = await load(current));
  }
  if (error) throw new Error(`Could not load webhooks: ${error.message}`);
  return { rows: data ?? [], total: count ?? 0, page: current };
}

export const LEADS_PAGE_SIZE = 50;

/** "Book a demo" requests from the website, newest first (docs/DECISIONS.md W-6). */
export async function listSiteLeads(page: number) {
  const supabase = await createClient();
  const load = (at: number) => {
    const from = (at - 1) * LEADS_PAGE_SIZE;
    return supabase
      .from('site_leads')
      .select(
        'id, name, restaurant_name, city, phone, email, plan_code, message, source, created_at',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(from, from + LEADS_PAGE_SIZE - 1);
  };
  let current = page;
  let { data, error, count } = await load(current);
  if (error?.code === 'PGRST103' && current > 1) {
    current = 1;
    ({ data, error, count } = await load(current));
  }
  if (error) throw new Error(`Could not load leads: ${error.message}`);
  return { rows: data ?? [], total: count ?? 0, page: current };
}

/** The setup fee a payment link suggests (paise): the usual fee and the discount on it. */
export async function getSetupFee(): Promise<{ feePaise: number; discountPaise: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('platform_settings')
    .select('setup_fee_paise, setup_fee_discount_paise')
    .eq('id', 1)
    .single();
  if (error) throw new Error(`Could not load platform settings: ${error.message}`);
  return { feePaise: data.setup_fee_paise, discountPaise: data.setup_fee_discount_paise };
}

export async function getTrialDays(): Promise<number> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('platform_settings')
    .select('trial_days')
    .eq('id', 1)
    .single();
  if (error) throw new Error(`Could not load platform settings: ${error.message}`);
  return data.trial_days;
}
