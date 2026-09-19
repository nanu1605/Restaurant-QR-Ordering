import { firstParam, isDate, type SearchParams } from '@/lib/date-range';

import {
  ACTOR_TYPES,
  SUBSCRIPTION_STATUSES,
  type ActorType,
  type SubscriptionStatus,
} from './platform';

/**
 * Super-admin list filters from page URLs. Unknown values are dropped rather
 * than sent to the database, which would refuse them.
 */

function page(params: SearchParams): number {
  const value = Number(firstParam(params, 'page'));
  return Number.isInteger(value) && value >= 1 && value <= 10000 ? value : 1;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

export const RESTAURANT_SORTS = ['created', 'name', 'last_order'] as const;
export type RestaurantSort = (typeof RESTAURANT_SORTS)[number];

export type RestaurantFilters = {
  q?: string;
  status?: 'active' | 'suspended';
  plan?: string;
  subscription?: SubscriptionStatus;
  city?: string;
  from?: string;
  to?: string;
  sort?: RestaurantSort;
  page: number;
};

export function readRestaurantFilters(params: SearchParams): RestaurantFilters {
  const from = firstParam(params, 'from');
  const to = firstParam(params, 'to');
  const validFrom = isDate(from) ? from : undefined;
  const validTo = isDate(to) && (!validFrom || to >= validFrom) ? to : undefined;
  const plan = firstParam(params, 'plan');
  return {
    q: firstParam(params, 'q')?.slice(0, 80),
    status: oneOf(firstParam(params, 'status'), ['active', 'suspended'] as const),
    plan: plan && /^[a-z_]{2,30}$/.test(plan) ? plan : undefined,
    subscription: oneOf(firstParam(params, 'subscription'), SUBSCRIPTION_STATUSES),
    city: firstParam(params, 'city')?.slice(0, 80),
    from: validFrom,
    to: validTo,
    sort: oneOf(firstParam(params, 'sort'), RESTAURANT_SORTS),
    page: page(params),
  };
}

export type SubscriptionFilters = { status?: SubscriptionStatus; page: number };

export function readSubscriptionFilters(params: SearchParams): SubscriptionFilters {
  return {
    status: oneOf(firstParam(params, 'status'), SUBSCRIPTION_STATUSES),
    page: page(params),
  };
}

export type AuditFilters = {
  restaurant_id?: string;
  actor_type?: ActorType;
  action?: string;
  from?: string;
  to?: string;
  page: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readAuditFilters(params: SearchParams): AuditFilters {
  const restaurant = firstParam(params, 'restaurant');
  const action = firstParam(params, 'action')?.toLowerCase();
  const from = firstParam(params, 'from');
  const to = firstParam(params, 'to');
  const validFrom = isDate(from) ? from : undefined;
  return {
    restaurant_id: restaurant && UUID.test(restaurant) ? restaurant : undefined,
    actor_type: oneOf(firstParam(params, 'actor'), ACTOR_TYPES),
    action: action && /^[a-z_.]{1,60}$/.test(action) ? action : undefined,
    from: validFrom,
    to: isDate(to) && (!validFrom || to >= validFrom) ? to : undefined,
    page: page(params),
  };
}

/** Filters as URL params (page 1 is the default and left out). */
export function filterParams(filters: Record<string, string | number | undefined>) {
  const params: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === '' || (key === 'page' && value === 1)) continue;
    params[key] = String(value);
  }
  return params;
}
