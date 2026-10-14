import { firstParam, isDate, type SearchParams } from '@/lib/date-range';

import { ACTIVITY_KINDS, HOME_PERIODS, type ActivityKind, type HomePeriod } from './home';

import {
  ACQUISITION_CHANNELS,
  ACTOR_TYPES,
  DEFAULT_RESTAURANT_COLUMNS,
  DUES_BUCKETS,
  HEALTHS,
  PAYMENT_METHODS,
  PAYMENT_PURPOSES,
  RESTAURANT_COLUMNS,
  SUBSCRIPTION_STATES,
  type AcquisitionChannel,
  type ActorType,
  type DuesBucket,
  type Health,
  type PaymentMethod,
  type PaymentPurpose,
  type RestaurantColumn,
  type SubscriptionState,
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

/** A from/to pair of dates; an end before the start is dropped. */
function dateRange(params: SearchParams, fromKey: string, toKey: string) {
  const from = firstParam(params, fromKey);
  const to = firstParam(params, toKey);
  const validFrom = isDate(from) ? from : undefined;
  return [validFrom, isDate(to) && (!validFrom || to >= validFrom) ? to : undefined] as const;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ActivityParams = { kind?: ActivityKind; before?: string };

/** The activity stream's kind and page (docs/DECISIONS.md SA-29). */
export function readActivityParams(params: SearchParams): ActivityParams {
  const before = firstParam(params, 'before');
  return {
    kind: oneOf(firstParam(params, 'kind'), ACTIVITY_KINDS),
    before: before && before.length <= 200 && before.includes('|') ? before : undefined,
  };
}

export type HomeParams = ActivityParams & { period: HomePeriod };

/** Home (docs/DECISIONS.md SA-27, SA-29): the period, and the activity's kind and page. */
export function readHomeParams(params: SearchParams): HomeParams {
  return {
    period: oneOf(firstParam(params, 'period'), HOME_PERIODS) ?? 'today',
    ...readActivityParams(params),
  };
}

export const RESTAURANT_SORTS = ['created', 'name', 'last_active', 'paid_till', 'gmv'] as const;
export type RestaurantSort = (typeof RESTAURANT_SORTS)[number];

export type RestaurantFilters = {
  q?: string;
  state?: SubscriptionState;
  plan?: string;
  health?: Health;
  city?: string;
  region?: string;
  channel?: AcquisitionChannel | 'unknown';
  /** A tag's id. */
  tag?: string;
  /** 'me', 'none' or a team member's user id (docs/DECISIONS.md SA-39). */
  manager?: string;
  from?: string;
  to?: string;
  paid_from?: string;
  paid_to?: string;
  sort?: RestaurantSort;
  dir?: 'asc' | 'desc';
  page: number;
};

/** Restaurants list filters (docs/DECISIONS.md SA-23); `cols` is the page's, not the database's. */
export function readRestaurantFilters(params: SearchParams): RestaurantFilters {
  const [from, to] = dateRange(params, 'from', 'to');
  const [paidFrom, paidTo] = dateRange(params, 'paid_from', 'paid_to');
  const plan = firstParam(params, 'plan');
  const tag = firstParam(params, 'tag');
  const manager = firstParam(params, 'manager');
  return {
    q: firstParam(params, 'q')?.slice(0, 80),
    state: oneOf(firstParam(params, 'state'), SUBSCRIPTION_STATES),
    plan: plan && /^[a-z_]{2,30}$/.test(plan) ? plan : undefined,
    health: oneOf(firstParam(params, 'health'), HEALTHS),
    city: firstParam(params, 'city')?.slice(0, 80),
    region: firstParam(params, 'region')?.slice(0, 80),
    channel: oneOf(firstParam(params, 'channel'), [...ACQUISITION_CHANNELS, 'unknown'] as const),
    tag: tag && UUID.test(tag) ? tag : undefined,
    manager:
      manager === 'me' || manager === 'none' || (manager && UUID.test(manager))
        ? manager
        : undefined,
    from,
    to,
    paid_from: paidFrom,
    paid_to: paidTo,
    sort: oneOf(firstParam(params, 'sort'), RESTAURANT_SORTS),
    dir: oneOf(firstParam(params, 'dir'), ['asc', 'desc'] as const),
    page: page(params),
  };
}

/** The restaurants list's chosen columns; none chosen means the default set. */
export function readRestaurantColumns(params: SearchParams): RestaurantColumn[] {
  // A comma list in links, one value per checkbox from the filter form.
  const value = params.cols;
  const chosen = (Array.isArray(value) ? value : [value ?? ''])
    .flatMap((text) => text.split(','))
    .map((text) => text.trim());
  const columns = RESTAURANT_COLUMNS.filter((column) => chosen.includes(column));
  return columns.length > 0 ? columns : DEFAULT_RESTAURANT_COLUMNS;
}

export type SubscriptionFilters = { state?: SubscriptionState; page: number };

export function readSubscriptionFilters(params: SearchParams): SubscriptionFilters {
  return {
    state: oneOf(firstParam(params, 'state'), SUBSCRIPTION_STATES),
    page: page(params),
  };
}

export type PaymentFilters = {
  /** 'all' for every payment ever; otherwise from and to (default: this month). */
  period?: 'all';
  from?: string;
  to?: string;
  q?: string;
  purpose?: PaymentPurpose;
  method?: PaymentMethod;
  plan?: string;
  page: number;
};

/** Payments ledger filters; with no dates and no `period=all`, this month so far (India). */
export function readPaymentFilters(params: SearchParams, today: string): PaymentFilters {
  const plan = firstParam(params, 'plan');
  const common = {
    q: firstParam(params, 'q')?.slice(0, 80),
    purpose: oneOf(firstParam(params, 'purpose'), PAYMENT_PURPOSES),
    method: oneOf(firstParam(params, 'method'), PAYMENT_METHODS),
    plan: plan && /^[a-z_]{2,30}$/.test(plan) ? plan : undefined,
    page: page(params),
  };
  const from = firstParam(params, 'from');
  const to = firstParam(params, 'to');
  const validFrom = isDate(from) ? from : undefined;
  const validTo = isDate(to) && (!validFrom || to >= validFrom) ? to : undefined;
  if (validFrom || validTo) return { from: validFrom, to: validTo, ...common };
  if (firstParam(params, 'period') === 'all') return { period: 'all', ...common };
  return { from: `${today.slice(0, 8)}01`, to: today, ...common };
}

export type DuesFilters = { bucket: DuesBucket; days: 7 | 30; q?: string; page: number };

export function readDuesFilters(params: SearchParams): DuesFilters {
  return {
    bucket: oneOf(firstParam(params, 'bucket'), DUES_BUCKETS) ?? 'payment_failed',
    days: firstParam(params, 'days') === '7' ? 7 : 30,
    q: firstParam(params, 'q')?.slice(0, 80),
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

/** The restaurants list's URL params: filters, sort and the columns when not the default. */
export function restaurantParams(filters: RestaurantFilters, columns: RestaurantColumn[]) {
  const isDefault =
    columns.length === DEFAULT_RESTAURANT_COLUMNS.length &&
    columns.every((column, index) => column === DEFAULT_RESTAURANT_COLUMNS[index]);
  return { ...filterParams(filters), cols: isDefault ? undefined : columns.join(',') };
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
