import { Signpost } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { EmptyState } from '@/components/shared/empty-state';
import { Money } from '@/components/shared/money';
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
import { StepButton } from '@/features/platform/components/standees-section';
import { filterParams } from '@/features/platform/params';
import { formatDate } from '@/features/platform/platform';
import { listStandees } from '@/features/platform/queries';
import {
  readStandeeFilters,
  STANDEE_STATUS_LABELS,
  STANDEE_TAB_LABELS,
  STANDEE_TABS,
  type StandeeRow,
} from '@/features/platform/standees';
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/auth/guards';
import { hrefWithParams } from '@/lib/date-range';

export const metadata: Metadata = {
  title: 'Standees',
};

const PATH = '/super/standees';
const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';

/**
 * The standee tracker (docs/SUPER_ADMIN_PLAN.md 14c, docs/DECISIONS.md SA-84,
 * SA-85): restaurants whose setup fee is paid and those with standees, by
 * status, the longest waiting first.
 */
export default async function StandeesPage({ searchParams }: PageProps<'/super/standees'>) {
  await requirePlatformPermission('restaurants.view');
  const filters = readStandeeFilters(await searchParams);
  const [list, manage, money] = await Promise.all([
    listStandees(filters),
    hasPlatformPermission('restaurants.manage'),
    hasPlatformPermission('money.view'),
  ]);
  const tab = filters.status ?? 'open';
  if (list.rows.length === 0 && filters.page > 1) {
    redirect(hrefWithParams(PATH, filterParams({ status: filters.status })));
  }

  return (
    <>
      <PageHeader
        title="Standees"
        description="QR standees from print to the restaurant’s tables. A restaurant appears once its setup fee is paid; days are India’s."
      />
      <nav aria-label="Status" className="flex flex-wrap gap-2">
        {STANDEE_TABS.map((value) => (
          <Link
            key={value}
            href={hrefWithParams(
              PATH,
              filterParams({ status: value === 'open' ? undefined : value }),
            )}
            aria-current={tab === value ? 'page' : undefined}
            className={buttonVariants({
              variant: tab === value ? 'default' : 'outline',
              size: 'sm',
            })}
          >
            {STANDEE_TAB_LABELS[value]} ({(list.counts[value] ?? 0).toLocaleString('en-IN')})
          </Link>
        ))}
      </nav>

      {list.rows.length === 0 ? (
        <EmptyState
          icon={Signpost}
          title="No standees here"
          description="Restaurants show here once their setup fee is paid, or standees are added on their page."
        />
      ) : (
        <>
          <ul aria-label="Standees" className="flex flex-col gap-3 md:hidden">
            {list.rows.map((row) => (
              <li
                key={row.restaurant_id}
                className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-sm"
              >
                <RestaurantCell row={row} />
                <p>
                  {STANDEE_STATUS_LABELS[row.status]} · {row.quantity} · since{' '}
                  {formatDate(row.since)}
                </p>
                {manage && (
                  <StepButton
                    restaurantId={row.restaurant_id}
                    status={row.status}
                    name={row.name}
                  />
                )}
              </li>
            ))}
          </ul>
          <div className="hidden rounded-lg border border-line bg-surface md:block">
            <Table label="Standees">
              <TableHeader>
                <TableRow>
                  <TableHead>Restaurant</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>How many</TableHead>
                  <TableHead>Since</TableHead>
                  <TableHead>Setup fee</TableHead>
                  <TableHead>Vendor</TableHead>
                  {money && <TableHead>Cost</TableHead>}
                  {manage && (
                    <TableHead>
                      <span className="sr-only">Next step</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.rows.map((row) => (
                  <TableRow key={row.restaurant_id}>
                    <TableCell className="max-w-64 min-w-48 whitespace-normal">
                      <RestaurantCell row={row} />
                    </TableCell>
                    <TableCell>{STANDEE_STATUS_LABELS[row.status]}</TableCell>
                    <TableCell className="tabular-nums">{row.quantity}</TableCell>
                    <TableCell className="tabular-nums">{formatDate(row.since)}</TableCell>
                    <TableCell className="tabular-nums">
                      {row.setup_fee_paid_at ? formatDate(row.setup_fee_paid_at) : 'Not paid'}
                    </TableCell>
                    <TableCell className="max-w-40 truncate">{row.vendor ?? '—'}</TableCell>
                    {money && (
                      <TableCell>
                        {row.cost_paise === null ? (
                          '—'
                        ) : (
                          <Money paise={row.cost_paise} fraction="auto" />
                        )}
                      </TableCell>
                    )}
                    {manage && (
                      <TableCell>
                        <StepButton
                          restaurantId={row.restaurant_id}
                          status={row.status}
                          name={row.name}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pager
            page={list.page}
            pageSize={list.page_size}
            total={list.total}
            hrefFor={(page) => hrefWithParams(PATH, filterParams({ status: filters.status, page }))}
          />
        </>
      )}
    </>
  );
}

function RestaurantCell({ row }: { row: StandeeRow }) {
  return (
    <span>
      <Link href={`/super/restaurants/${row.restaurant_id}#section-standees`} className={linkClass}>
        {row.name}
      </Link>
      {row.city && <span className="block text-xs text-ink-muted">{row.city}</span>}
    </span>
  );
}
