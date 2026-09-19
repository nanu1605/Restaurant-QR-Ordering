import { Building2, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Pager } from '@/components/shared/pager';
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
import { AccessBadge, SubscriptionBadge } from '@/features/platform/components/status-badges';
import { filterParams, readRestaurantFilters } from '@/features/platform/params';
import { formatDate, formatDateTime } from '@/features/platform/platform';
import { listPlans, listRestaurants } from '@/features/platform/queries';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { hrefWithParams } from '@/lib/date-range';

export const metadata: Metadata = {
  title: 'Restaurants',
};

/** Restaurants (spec §13.4): searchable and filterable, 50 per page. */
export default async function SuperRestaurantsPage({
  searchParams,
}: PageProps<'/super/restaurants'>) {
  await requirePlatformAdmin();
  const filters = readRestaurantFilters(await searchParams);
  const [list, plans] = await Promise.all([listRestaurants(filters), listPlans()]);
  const filtered = Object.keys(filterParams({ ...filters, page: 1 })).length > 0;

  return (
    <>
      <PageHeader
        title="Restaurants"
        description={`${list.total} ${list.total === 1 ? 'restaurant' : 'restaurants'}${filtered ? ' match' : ''}.`}
        actions={
          <Link href="/super/restaurants/new" className={buttonVariants({ size: 'touch' })}>
            <Plus aria-hidden />
            Onboard restaurant
          </Link>
        }
      />
      <RestaurantsFilters
        filters={filters}
        cities={list.cities}
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Restaurant</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Subscription</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Last order</TableHead>
                <TableHead>Created</TableHead>
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
                    <div className="text-xs text-ink-muted">{row.slug}</div>
                  </TableCell>
                  <TableCell>{row.city ?? '—'}</TableCell>
                  <TableCell>{row.plan_name ?? '—'}</TableCell>
                  <TableCell>
                    <SubscriptionBadge status={row.subscription_status} />
                    {row.subscription_status === 'trialing' && (
                      <div className="text-xs text-ink-muted">
                        ends {formatDate(row.trial_ends_at)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <AccessBadge status={row.status} accessState={row.access_state} />
                  </TableCell>
                  <TableCell>{formatDateTime(row.last_order_at)}</TableCell>
                  <TableCell>{formatDate(row.created_at)}</TableCell>
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
        hrefFor={(page) => hrefWithParams('/super/restaurants', filterParams({ ...filters, page }))}
      />
    </>
  );
}
