import 'server-only';

import { cache } from 'react';

import type { PlatformPermission } from '@/lib/auth/permissions';
import { dbErrorCode } from '@/lib/db-errors';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import {
  parseActivityPage,
  parseAlerts,
  parseAttention,
  parseHome,
  type ActivityKind,
  type HomePeriod,
} from './home';
import type {
  AuditFilters,
  DuesFilters,
  PaymentFilters,
  RestaurantFilters,
  SubscriptionFilters,
} from './params';
import {
  parseAuditList,
  parseDuesList,
  parseLookalikes,
  parsePaymentList,
  parseRestaurantDetail,
  parseRestaurantList,
  parseSearchResults,
  parseSubscriptionList,
  planSchema,
  supportRestaurantSchema,
  tagSchema,
  type SupportSection,
} from './platform';
import { parseBilling, parseNotes, parseOverview, parseTeam, parseUsage } from './restaurant-page';
import { setupFeeDiscountPaise } from './setup-fee';
import { parseOffers } from './offers';
import { parseStandeeDetail, parseStandeeList, type StandeeFilters } from './standees';
import { parseTeamList } from './team';

/**
 * Super-admin reads (spec §13.4). They run as the signed-in platform admin;
 * the database checks the second factor (docs/DECISIONS.md P7-1).
 */

/** Home's key numbers and charts (docs/DECISIONS.md SA-27). */
export async function getHome(period: HomePeriod) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_home', { p_period: period });
  if (error) throw new Error(`Could not load Home: ${error.message}`);
  return parseHome(data);
}

/** Needs attention, less this admin's snoozes (docs/DECISIONS.md SA-28). */
export async function getNeedsAttention() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_needs_attention');
  if (error) throw new Error(`Could not load Needs attention: ${error.message}`);
  return parseAttention(data);
}

/** A page of the activity stream (docs/DECISIONS.md SA-29); null on a stale cursor. */
export async function listActivity({
  kinds,
  before,
  restaurantId,
  limit = 30,
}: {
  kinds?: ActivityKind[];
  before?: string;
  restaurantId?: string;
  limit?: number;
}) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_activity', {
    p_restaurant_id: restaurantId,
    p_kinds: kinds,
    p_before: before,
    p_limit: limit,
  });
  if (error) throw new Error(`Could not load the activity: ${error.message}`);
  return parseActivityPage(data);
}

/** What this admin hasn't seen yet, for the bell (docs/DECISIONS.md SA-30). */
export async function getAlerts() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_alerts');
  if (error) throw new Error(`Could not load the alerts: ${error.message}`);
  return parseAlerts(data);
}

/** The restaurants list (docs/DECISIONS.md SA-23); `exportAll` returns every row on one page. */
export async function listRestaurants(filters: RestaurantFilters, exportAll = false) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_list_restaurants', {
    p_filters: exportAll ? { ...filters, page: 1, export: true } : filters,
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

/** The payments ledger (docs/DECISIONS.md SA-18); `exportAll` returns every row on one page. */
export async function listPayments(filters: PaymentFilters, exportAll = false) {
  const supabase = await createClient();
  // `period: 'all'` is the absence of dates.
  const { from, to, q, purpose, method, plan, page } = filters;
  const sent = { from, to, q, purpose, method, plan, page };
  const { data, error } = await supabase.rpc('platform_list_payments', {
    p_filters: exportAll ? { ...sent, page: 1, export: true } : sent,
  });
  if (error) throw new Error(`Could not load payments: ${error.message}`);
  return parsePaymentList(data);
}

/** Dues buckets (docs/DECISIONS.md SA-19). */
export async function listDues(filters: DuesFilters) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_list_dues', { p_filters: filters });
  if (error) throw new Error(`Could not load dues: ${error.message}`);
  return parseDuesList(data);
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
// One read per request: the restaurant page's layout and its tab both ask.
export const getRestaurantDetail = cache(async (restaurantId: string) => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_get_restaurant', {
    p_restaurant_id: restaurantId,
  });
  if (error) {
    if (dbErrorCode(error) === 'RESTAURANT_NOT_FOUND' || error.code === '22P02') return null;
    throw new Error(`Could not load the restaurant: ${error.message}`);
  }
  return parseRestaurantDetail(data);
});

// ─── A restaurant's tabs (docs/DECISIONS.md SA-35 to SA-38) ──────────────────
async function restaurantRpc(
  fn: 'platform_restaurant_overview' | 'platform_restaurant_billing' | 'platform_restaurant_usage',
  restaurantId: string,
) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, { p_restaurant_id: restaurantId });
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data;
}

export async function getRestaurantOverview(restaurantId: string) {
  return parseOverview(await restaurantRpc('platform_restaurant_overview', restaurantId));
}

export async function getRestaurantBilling(restaurantId: string) {
  return parseBilling(await restaurantRpc('platform_restaurant_billing', restaurantId));
}

export async function getRestaurantUsage(restaurantId: string) {
  return parseUsage(await restaurantRpc('platform_restaurant_usage', restaurantId));
}

export async function listNotes(restaurantId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_list_notes', {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(`Could not load the notes: ${error.message}`);
  return parseNotes(data);
}

/** Every tag, by name (docs/DECISIONS.md SA-39). */
export async function listTags() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('platform_tags')
    .select('id, name, colour')
    .order('name');
  if (error) throw new Error(`Could not load the tags: ${error.message}`);
  return tagSchema.array().parse(data);
}

/**
 * The MenuMesh team's active members, for choosing an account manager, or,
 * with a permission, an assignee who can open the area.
 */
export async function getTeam(permission?: PlatformPermission) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_team');
  if (error) throw new Error(`Could not load the team: ${error.message}`);
  const team = parseTeam(data);
  return permission ? team.filter((member) => member.permissions.includes(permission)) : team;
}

/** Every offer, live first, with how often it was used (docs/DECISIONS.md SA-77+). */
export async function listOffers() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_list_offers');
  if (error) throw new Error(`Could not load the offers: ${error.message}`);
  return parseOffers(data);
}

/** One restaurant's standees, active tables and setup fee (docs/DECISIONS.md SA-84). */
export async function getStandees(restaurantId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_get_standees', {
    p_restaurant_id: restaurantId,
  });
  if (error) throw new Error(`Could not load the standees: ${error.message}`);
  return parseStandeeDetail(data);
}

/** The standee tracker, by status (docs/DECISIONS.md SA-84). */
export async function listStandees(filters: StandeeFilters) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_list_standees', {
    p_status: filters.status ?? 'open',
    p_page: filters.page,
  });
  if (error) throw new Error(`Could not load the standees: ${error.message}`);
  return parseStandeeList(data);
}

/** Everyone on the team, for the Team page (docs/DECISIONS.md SA-70+). */
export async function listTeam() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_list_team');
  if (error) throw new Error(`Could not load the team: ${error.message}`);
  return parseTeamList(data);
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

/** The admin's own and the team's shared views of a page, by name (docs/DECISIONS.md SA-24). */
export async function listSavedViews(page: 'restaurants') {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('platform_saved_views')
    .select('id, owner_id, name, query, shared')
    .eq('page', page)
    .order('name');
  if (error) throw new Error(`Could not load saved views: ${error.message}`);
  return data;
}

/** Restaurants, payments and leads matching what was typed (docs/DECISIONS.md SA-25). */
export async function searchPlatform(q: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_search', { p_q: q });
  if (error) throw new Error(`Could not search: ${error.message}`);
  return parseSearchResults(data);
}

/** The setup fee a payment link suggests (paise): the usual fee and the discount in force. */
export async function getSetupFee(): Promise<{ feePaise: number; discountPaise: number }> {
  const settings = await getPlatformSettings();
  return { feePaise: settings.setup_fee_paise, discountPaise: setupFeeDiscountPaise(settings) };
}

export async function getPlatformSettings() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('platform_settings')
    .select(
      'trial_days, grace_days, setup_fee_paise, setup_fee_discount_paise, setup_fee_discount_ends_at, support_phone, support_email, health_setup_days, health_inactive_days, health_slowing_percent, health_slowing_min_orders',
    )
    .eq('id', 1)
    .single();
  if (error) throw new Error(`Could not load platform settings: ${error.message}`);
  return data;
}

export type PlatformSettings = Awaited<ReturnType<typeof getPlatformSettings>>;

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
