import { CreditCard } from 'lucide-react';
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
import { AccessBadge, SubscriptionBadge } from '@/features/platform/components/status-badges';
import { filterParams, readSubscriptionFilters } from '@/features/platform/params';
import {
  formatDateTime,
  PAYMENT_SOURCE_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  SUBSCRIPTION_STATUSES,
} from '@/features/platform/platform';
import { listSubscriptions } from '@/features/platform/queries';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { hrefWithParams } from '@/lib/date-range';

export const metadata: Metadata = {
  title: 'Subscriptions',
};

const PATH = '/super/subscriptions';

/** Subscriptions (spec §13.4): status filter, payment problems first. */
export default async function SuperSubscriptionsPage({
  searchParams,
}: PageProps<'/super/subscriptions'>) {
  await requirePlatformAdmin();
  const filters = readSubscriptionFilters(await searchParams);
  const list = await listSubscriptions(filters);

  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Failed payments first, then whatever ends soonest."
      />
      <nav aria-label="Subscription status" className="flex flex-wrap gap-2">
        {[undefined, ...SUBSCRIPTION_STATUSES].map((status) => (
          <Link
            key={status ?? 'all'}
            href={hrefWithParams(PATH, { status })}
            aria-current={filters.status === status ? 'page' : undefined}
            className={buttonVariants({
              variant: filters.status === status ? 'default' : 'outline',
              size: 'touch',
            })}
          >
            {status ? SUBSCRIPTION_STATUS_LABELS[status] : 'All'}
          </Link>
        ))}
      </nav>

      {list.rows.length === 0 ? (
        <EmptyState icon={CreditCard} title="No subscriptions here" />
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          <Table label="Subscriptions">
            <TableHeader>
              <TableRow>
                <TableHead>Restaurant</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Trial or period ends</TableHead>
                <TableHead>Grace until</TableHead>
                <TableHead>Access</TableHead>
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
                  </TableCell>
                  <TableCell>
                    {row.plan_name}
                    {row.billing_cycle && (
                      <div className="text-xs text-ink-muted">
                        {row.billing_cycle === 'yearly' ? 'Yearly' : 'Monthly'}
                        {row.source ? `, ${PAYMENT_SOURCE_LABELS[row.source] ?? row.source}` : ''}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <SubscriptionBadge status={row.status} />
                    {row.cancel_at_period_end && (
                      <div className="text-xs text-ink-muted">Cancels at period end</div>
                    )}
                  </TableCell>
                  <TableCell>
                    {formatDateTime(
                      row.status === 'trialing' ? row.trial_ends_at : row.current_period_end,
                    )}
                  </TableCell>
                  <TableCell>{formatDateTime(row.grace_until)}</TableCell>
                  <TableCell>
                    <AccessBadge status={row.restaurant_status} accessState={row.access_state} />
                  </TableCell>
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
        hrefFor={(page) => hrefWithParams(PATH, filterParams({ ...filters, page }))}
      />
    </>
  );
}
