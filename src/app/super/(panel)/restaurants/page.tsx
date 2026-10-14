import { ArrowDown, ArrowUp, ArrowUpDown, Building2, Download, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { EmptyState } from '@/components/shared/empty-state';
import { Money } from '@/components/shared/money';
import { PageHeader } from '@/components/shared/page-header';
import { Pager } from '@/components/shared/pager';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RestaurantsFilters } from '@/features/platform/components/restaurants-filters';
import { DeleteViewButton, SaveViewButton } from '@/features/platform/components/saved-views';
import { Sparkline } from '@/features/platform/components/sparkline';
import { HealthBadge, SubscriptionStateBadge } from '@/features/platform/components/status-badges';
import { formatMobile, telHref, whatsappHref } from '@/features/platform/dues-messages';
import {
  readRestaurantColumns,
  readRestaurantFilters,
  restaurantParams,
  type RestaurantSort,
} from '@/features/platform/params';
import {
  ACQUISITION_CHANNEL_LABELS,
  formatDate,
  formatDateTime,
  RESTAURANT_COLUMN_LABELS,
  todayInIndia,
  type Lookalike,
  type RestaurantColumn,
  type RestaurantRow,
} from '@/features/platform/platform';
import {
  getLookalikes,
  getPlatformSettings,
  listPlans,
  listRestaurants,
  listSavedViews,
} from '@/features/platform/queries';
import { paidTillDay } from '@/features/platform/restaurants-csv';
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/auth/guards';
import { addDays, hrefWithParams } from '@/lib/date-range';

export const metadata: Metadata = {
  title: 'Restaurants',
};

const PATH = '/super/restaurants';

const SORTABLE: Partial<Record<RestaurantColumn | 'restaurant', RestaurantSort>> = {
  restaurant: 'name',
  paid_till: 'paid_till',
  gmv: 'gmv',
  last_active: 'last_active',
  created: 'created',
};

const defaultDir = (sort: RestaurantSort) => (sort === 'name' ? 'asc' : 'desc');

/** A query string in a fixed order, to tell whether a view is the one showing. */
const normalise = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value) search.set(key, value);
  }
  return search.toString();
};

/**
 * Restaurants (docs/SUPER_ADMIN_PLAN.md 12d, docs/DECISIONS.md SA-22 to
 * SA-24): state, money, usage and health at a glance, with filters, sorting,
 * columns, saved views and a CSV.
 */
export default async function SuperRestaurantsPage({
  searchParams,
}: PageProps<'/super/restaurants'>) {
  const user = await requirePlatformPermission('restaurants.view');
  const params = await searchParams;
  const filters = readRestaurantFilters(params);
  // Lifetime paid is money (docs/DECISIONS.md SA-23).
  const money = await hasPlatformPermission('money.view');
  const columns = readRestaurantColumns(params).filter((column) => money || column !== 'lifetime');
  const [list, plans, views, settings] = await Promise.all([
    listRestaurants(filters),
    listPlans(),
    listSavedViews('restaurants'),
    getPlatformSettings(),
  ]);
  // Restaurants that may be the same as another: worth a look (docs/DECISIONS.md P11-13).
  // Only a badge, so the list still shows when the check fails or runs out of time.
  const lookalikes = await getLookalikes(list.rows.map((row) => row.restaurant_id)).catch(
    (error: unknown): Record<string, Lookalike[]> => {
      console.error(error);
      return {};
    },
  );
  const current = restaurantParams({ ...filters, page: 1 }, columns);
  const filtered = Object.keys(
    restaurantParams({ ...filters, page: 1, sort: undefined, dir: undefined }, columns),
  ).some((key) => key !== 'cols');
  const today = todayInIndia();
  const builtIn: { name: string; params: Record<string, string> }[] = [
    { name: 'Payment failed', params: { state: 'payment_failed' } },
    {
      name: 'Trial ending',
      params: { state: 'trial', paid_from: today, paid_to: addDays(today, 3) },
    },
    { name: 'Lapsed', params: { state: 'read_only' } },
    {
      name: `No orders in ${settings.health_inactive_days} days`,
      params: { health: 'inactive' },
    },
    { name: 'Never started', params: { health: 'never_started' } },
    { name: 'Slowing', params: { health: 'slowing' } },
    { name: 'Paid', params: { state: 'paid' } },
  ];
  const currentQuery = normalise(current);
  const shown = (column: RestaurantColumn) => columns.includes(column);

  const header = (key: RestaurantColumn | 'restaurant', label: string) => {
    const sort = SORTABLE[key];
    if (!sort) return <TableHead key={key}>{label}</TableHead>;
    const active = (filters.sort ?? 'created') === sort;
    const dir = active ? (filters.dir ?? defaultDir(sort)) : undefined;
    const next = active ? (dir === 'asc' ? 'desc' : 'asc') : defaultDir(sort);
    const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
    return (
      <TableHead
        key={key}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
      >
        <Link
          href={hrefWithParams(
            PATH,
            restaurantParams({ ...filters, sort, dir: next, page: 1 }, columns),
          )}
          className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
        >
          {label}
          <Icon aria-hidden className={active ? 'size-3.5' : 'size-3.5 opacity-50'} />
        </Link>
      </TableHead>
    );
  };

  return (
    <>
      <PageHeader
        title="Restaurants"
        description={`${list.total} ${list.total === 1 ? 'restaurant' : 'restaurants'}${filtered ? ' match' : ''}.`}
        actions={
          <>
            <a
              href={hrefWithParams(`${PATH}/export`, current)}
              download
              className={buttonVariants({ variant: 'outline', size: 'touch' })}
            >
              <Download aria-hidden />
              Export CSV
            </a>
            <Link href="/super/restaurants/new" className={buttonVariants({ size: 'touch' })}>
              <Plus aria-hidden />
              Onboard restaurant
            </Link>
          </>
        }
      />

      <nav aria-label="Views" className="flex flex-wrap items-center gap-2">
        {builtIn.map((view) => {
          const query = normalise(view.params);
          return (
            <Link
              key={view.name}
              href={`${PATH}?${query}`}
              aria-current={query === currentQuery ? 'page' : undefined}
              className={buttonVariants({
                variant: query === currentQuery ? 'default' : 'outline',
                size: 'sm',
              })}
            >
              {view.name}
            </Link>
          );
        })}
        {views.map((view) => {
          const query = normalise(Object.fromEntries(new URLSearchParams(view.query)));
          const mine = view.owner_id === user.id;
          return (
            <span key={view.id} className="inline-flex items-center">
              <Link
                href={`${PATH}?${view.query}`}
                aria-current={query === currentQuery ? 'page' : undefined}
                className={buttonVariants({
                  variant: query === currentQuery ? 'default' : 'outline',
                  size: 'sm',
                })}
              >
                {view.name}
                {!mine && <span className="text-xs opacity-80">(shared)</span>}
              </Link>
              {mine && <DeleteViewButton viewId={view.id} name={view.name} shared={view.shared} />}
            </span>
          );
        })}
        <SaveViewButton
          query={new URLSearchParams(
            Object.entries(current).filter((e): e is [string, string] => !!e[1]),
          ).toString()}
        />
      </nav>

      <RestaurantsFilters
        filters={filters}
        columns={columns}
        money={money}
        cities={list.cities}
        regions={list.regions}
        plans={plans.map((plan) => ({ code: plan.code, name: plan.name }))}
      />

      {list.rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={filtered ? 'No restaurants match' : 'No restaurants yet'}
          description={
            filtered ? 'Change or clear the filters.' : 'Onboard the first restaurant to start.'
          }
        />
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {/* The padding keeps a focused row clear of the sticky header. */}
          <Table label="Restaurants" regionClassName="max-h-[75vh] scroll-pt-12 overflow-y-auto">
            <TableHeader className="sticky top-0 z-10 bg-surface">
              <TableRow>
                {header('restaurant', 'Restaurant')}
                {columns.map((column) => header(column, RESTAURANT_COLUMN_LABELS[column]))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.rows.map((row) => (
                <TableRow key={row.restaurant_id} data-slug={row.slug}>
                  <TableCell>
                    <Link
                      href={`/super/restaurants/${row.restaurant_id}`}
                      className="font-medium text-brand underline-offset-4 hover:underline"
                    >
                      {row.name}
                    </Link>
                    {(lookalikes[row.restaurant_id]?.length ?? 0) > 0 && (
                      <Badge variant="outline" className="ml-2" title="Possible duplicate">
                        Review
                      </Badge>
                    )}
                    <div className="text-xs text-ink-muted">
                      {[row.slug, row.city].filter(Boolean).join(', ')}
                    </div>
                  </TableCell>
                  {columns.map((column) => (
                    <TableCell key={column} data-col={column}>
                      {cell(column, row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pager
        page={list.page}
        pageSize={list.page_size}
        total={list.total}
        hrefFor={(page) => hrefWithParams(PATH, restaurantParams({ ...filters, page }, columns))}
      />
      {shown('gmv') && (
        <p className="text-xs text-ink-muted">
          GMV is what diners paid on the restaurant&apos;s bills, its own taxes included, over the
          last 30 finished business days. Orders are accepted orders per day.
        </p>
      )}
    </>
  );
}

function cell(column: RestaurantColumn, row: RestaurantRow): ReactNode {
  switch (column) {
    case 'state':
      return (
        <SubscriptionStateBadge state={row.state} endsAt={row.ending ? row.paid_till : null} />
      );
    case 'plan':
      return row.plan_name ?? '—';
    case 'paid_till': {
      const day = paidTillDay(row);
      if (!day) return '—';
      return row.subscription_status === 'trialing'
        ? `Trial till ${formatDate(day)}`
        : formatDate(day);
    }
    case 'lifetime': {
      if (!row.paid) return '—';
      const { subscription_paise, setup_fee_paise, gst_paise } = row.paid;
      const total = subscription_paise + setup_fee_paise;
      if (total === 0) return '—';
      return (
        <span className="flex flex-col">
          <Money paise={total} />
          {setup_fee_paise > 0 && (
            <span className="text-xs text-ink-muted">
              incl. setup <Money paise={setup_fee_paise} />
            </span>
          )}
          <span className="text-xs text-ink-muted">
            + GST <Money paise={gst_paise} />
          </span>
        </span>
      );
    }
    case 'gmv':
      return <Money paise={row.gmv_30d_paise} />;
    case 'orders': {
      const days = row.orders_7d ?? [];
      const total = days.reduce((sum, n) => sum + n, 0);
      return (
        <span className="inline-flex items-center gap-2">
          <Sparkline
            values={days}
            label={`Orders on each of the last 7 days: ${days.join(', ')}`}
          />
          <span className="tabular-nums">{total}</span>
        </span>
      );
    }
    case 'health':
      return (
        <HealthBadge
          health={row.health}
          muted={row.state === 'suspended' || row.state === 'read_only'}
        />
      );
    case 'last_active':
      return row.last_active ? formatDateTime(row.last_active) : 'Never';
    case 'phone': {
      const tel = telHref(row.phone);
      const whatsapp = whatsappHref(row.phone, '');
      if (!tel || !whatsapp) return row.phone ?? '—';
      return (
        <span className="flex flex-col">
          <span className="tabular-nums">{formatMobile(row.phone)}</span>
          <span className="flex gap-3 text-xs">
            <a
              href={tel}
              className="inline-flex min-h-6 items-center text-brand underline underline-offset-4"
              aria-label={`Call ${row.name}`}
            >
              Call
            </a>
            <a
              href={whatsapp}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-6 items-center text-brand underline underline-offset-4"
              aria-label={`WhatsApp ${row.name}`}
            >
              WhatsApp
            </a>
          </span>
        </span>
      );
    }
    case 'channel':
      return row.acquisition_channel
        ? ACQUISITION_CHANNEL_LABELS[row.acquisition_channel]
        : 'Not known';
    case 'created':
      return formatDate(row.created_at);
  }
}
