import { HandCoins } from 'lucide-react';
import type { Metadata } from 'next';
import Form from 'next/form';
import Link from 'next/link';

import { EmptyState } from '@/components/shared/empty-state';
import { Money } from '@/components/shared/money';
import { PageHeader } from '@/components/shared/page-header';
import { Pager } from '@/components/shared/pager';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DuesContact } from '@/features/platform/components/dues-contact';
import { DuesActions, type LinkDefaults } from '@/features/platform/components/restaurant-actions';
import { SubscriptionStateBadge } from '@/features/platform/components/status-badges';
import { duesMessage } from '@/features/platform/dues-messages';
import { filterParams, readDuesFilters } from '@/features/platform/params';
import { duesLinkDefaults } from '@/features/platform/payment-links';
import {
  ACCESS_REASON_LABELS,
  daysSince,
  daysUntil,
  DUES_BUCKET_LABELS,
  DUES_BUCKETS,
  firstUnpaidDay,
  formatDate,
  formatDateTime,
  periodLastDay,
  REMINDER_LABELS,
  RENEWAL_KIND_LABELS,
  RENEWAL_KINDS,
  type DuesBucket,
  type DuesRow,
} from '@/features/platform/platform';
import { getSetupFee, listDues, listPlans } from '@/features/platform/queries';
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/auth/guards';
import { hrefWithParams } from '@/lib/date-range';
import { razorpayConfig } from '@/lib/razorpay/razorpay';

export const metadata: Metadata = {
  title: 'Dues',
};

const PATH = '/super/money/dues';

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/**
 * Dues (docs/SUPER_ADMIN_PLAN.md 12c, docs/DECISIONS.md SA-19): who owes
 * MenuMesh and who soon will, with a way to call, message or take payment.
 */
export default async function DuesPage({ searchParams }: PageProps<'/super/money/dues'>) {
  await requirePlatformPermission('money.view');
  const manage = await hasPlatformPermission('restaurants.manage');
  const filters = readDuesFilters(await searchParams);
  const [list, plans, setupFee] = await Promise.all([
    listDues(filters),
    listPlans(),
    getSetupFee(),
  ]);
  const linkDefaults = duesLinkDefaults(plans, setupFee, razorpayConfig() !== null);
  const { bucket } = filters;
  const tabLink = (next: DuesBucket) =>
    hrefWithParams(PATH, filterParams({ bucket: next, q: filters.q }));
  const { expected } = list;

  const items = (rows: DuesRow[]) => (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <DuesItem
          key={row.restaurant_id}
          bucket={bucket}
          row={row}
          linkDefaults={linkDefaults(row)}
          manage={manage}
        />
      ))}
    </ul>
  );

  return (
    <>
      <PageHeader
        title="Dues"
        description="Who owes MenuMesh, and who soon will. Amounts include GST."
      />

      <section
        aria-labelledby="dues-expected"
        className="grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2"
      >
        <h2 id="dues-expected" className="text-sm font-medium text-ink-muted sm:col-span-2">
          Expected in the next 30 days, with GST
        </h2>
        <p className="flex flex-col">
          <Money paise={expected.autopay_paise} className="text-lg font-semibold text-ink" />
          <span className="text-sm text-ink-muted">
            on autopay, from {expected.autopay_count}{' '}
            {expected.autopay_count === 1 ? 'restaurant' : 'restaurants'}
          </span>
        </p>
        <p className="flex flex-col">
          <Money paise={expected.needs_payment_paise} className="text-lg font-semibold text-ink" />
          <span className="text-sm text-ink-muted">
            needing a payment, from {expected.needs_payment_count}{' '}
            {expected.needs_payment_count === 1 ? 'restaurant' : 'restaurants'}
          </span>
        </p>
      </section>

      <nav aria-label="Dues" className="flex flex-wrap gap-2">
        {DUES_BUCKETS.map((next) => (
          <Link
            key={next}
            href={tabLink(next)}
            aria-current={bucket === next ? 'page' : undefined}
            className={buttonVariants({
              variant: bucket === next ? 'default' : 'outline',
              size: 'touch',
            })}
          >
            {DUES_BUCKET_LABELS[next]}{' '}
            <span className="tabular-nums">({list.counts[next] ?? 0})</span>
          </Link>
        ))}
      </nav>

      <div className="flex flex-wrap items-end gap-3">
        <Form
          key={filters.q ?? ''}
          action={PATH}
          role="search"
          aria-label="Dues"
          className="flex flex-wrap items-end gap-2"
        >
          <input type="hidden" name="bucket" value={bucket} />
          {bucket === 'renewal_due' && <input type="hidden" name="days" value={filters.days} />}
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            Restaurant
            <Input
              type="search"
              name="q"
              defaultValue={filters.q}
              placeholder="Name or code"
              className="h-11 w-64 max-w-full md:h-9"
            />
          </label>
          <Button type="submit" size="touch" className="md:h-9">
            Search
          </Button>
        </Form>
        {bucket === 'renewal_due' && (
          <nav aria-label="Renewals within" className="flex gap-2">
            {([7, 30] as const).map((window) => (
              <Link
                key={window}
                href={hrefWithParams(
                  PATH,
                  filterParams({ bucket, days: window === 30 ? undefined : window, q: filters.q }),
                )}
                aria-current={filters.days === window ? 'page' : undefined}
                className={buttonVariants({
                  variant: filters.days === window ? 'default' : 'outline',
                  size: 'touch',
                  className: 'md:h-9',
                })}
              >
                Next {window} days
              </Link>
            ))}
          </nav>
        )}
      </div>

      {list.rows.length === 0 ? (
        <EmptyState
          icon={HandCoins}
          title={`No one in ${DUES_BUCKET_LABELS[bucket]}`}
          description={filters.q ? 'Nothing matches that search here.' : undefined}
        />
      ) : bucket === 'renewal_due' ? (
        RENEWAL_KINDS.map((kind) => {
          const rows = list.rows.filter((row) => row.renewal_kind === kind);
          if (rows.length === 0) return null;
          return (
            <section key={kind} aria-labelledby={`renewal-${kind}`} className="flex flex-col gap-3">
              <h2 id={`renewal-${kind}`} className="text-base font-semibold text-ink">
                {RENEWAL_KIND_LABELS[kind]}{' '}
                <span className="text-ink-muted tabular-nums">({list.kinds[kind] ?? 0})</span>
              </h2>
              {items(rows)}
            </section>
          );
        })
      ) : (
        items(list.rows)
      )}
      <Pager
        page={list.page}
        pageSize={list.page_size}
        total={list.total}
        hrefFor={(page) =>
          hrefWithParams(
            PATH,
            filterParams({
              bucket,
              days: filters.days === 30 ? undefined : filters.days,
              q: filters.q,
              page,
            }),
          )
        }
      />
    </>
  );
}

/** What each bucket says about a restaurant's dates. */
function details(bucket: DuesBucket, row: DuesRow): string[] {
  if (bucket === 'payment_failed') {
    const retry =
      row.razorpay_status === 'pending'
        ? 'Razorpay is retrying the charge'
        : row.razorpay_status === 'halted'
          ? 'Razorpay has stopped retrying'
          : null;
    return [
      row.grace_until
        ? `Grace until ${formatDateTime(row.grace_until)}, ${days(daysUntil(row.grace_until))} left`
        : 'No grace period set',
      ...(retry ? [retry] : []),
    ];
  }
  if (bucket === 'lapsed') {
    return [
      row.restriction_at
        ? `Read-only since ${formatDate(row.restriction_at)}, ${days(daysSince(row.restriction_at))}`
        : 'Read-only',
      ACCESS_REASON_LABELS[row.access_reason ?? ''] ?? 'Not paid',
    ];
  }
  if (bucket === 'trial_ending') {
    return row.trial_ends_at
      ? [
          `Trial ends ${formatDateTime(row.trial_ends_at)}, ${days(daysUntil(row.trial_ends_at))} left`,
        ]
      : [];
  }
  return row.current_period_end
    ? [`Paid till ${formatDate(periodLastDay(row.current_period_end))}`]
    : [];
}

function DuesItem({
  bucket,
  row,
  linkDefaults,
  manage,
}: {
  bucket: DuesBucket;
  row: DuesRow;
  linkDefaults: LinkDefaults | null;
  /** Extending a trial needs restaurants.manage (docs/SUPER_ADMIN_PLAN.md §3). */
  manage: boolean;
}) {
  const cycle = row.billing_cycle === 'yearly' ? 'yearly' : 'monthly';
  return (
    <li
      data-slug={row.slug}
      aria-label={row.name}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3 md:p-4"
    >
      <div className="grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_auto_minmax(0,1fr)] md:items-start">
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            href={`/super/restaurants/${row.restaurant_id}/billing`}
            className="font-medium break-words text-brand underline-offset-4 hover:underline"
          >
            {row.name}
          </Link>
          <span className="text-sm text-ink-muted">
            {[row.slug, row.city].filter(Boolean).join(', ')}
          </span>
          <SubscriptionStateBadge
            state={row.state}
            endsAt={row.renewal_kind === 'ending' ? row.current_period_end : null}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1 text-sm text-ink">
          <span>
            {row.plan_name}, {cycle}
          </span>
          {details(bucket, row).map((line) => (
            <span key={line} className="text-ink-muted">
              {line}
            </span>
          ))}
        </div>
        <div className="flex flex-col md:items-end">
          <Money paise={row.due_paise} className="font-semibold text-ink" />
          <span className="text-xs text-ink-muted">due, with GST</span>
        </div>
        <div className="flex min-w-0 flex-col text-sm">
          <span className="text-ink-muted">Last reminder email</span>
          <span className="text-ink">
            {row.last_reminder_kind && row.last_reminder_at
              ? `${REMINDER_LABELS[row.last_reminder_kind] ?? row.last_reminder_kind}, ${formatDate(row.last_reminder_at)}`
              : 'None sent'}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <DuesContact
          restaurantName={row.name}
          phone={row.phone}
          messages={{
            en: duesMessage(bucket, row, 'en'),
            hi: duesMessage(bucket, row, 'hi'),
          }}
        />
        <DuesActions
          restaurantId={row.restaurant_id}
          restaurantName={row.name}
          canExtendTrial={manage && row.status === 'trialing'}
          paymentStart={firstUnpaidDay({
            status: row.status,
            restrictionAt: row.restriction_at,
            currentPeriodEnd: row.current_period_end,
          })}
          linkDefaults={linkDefaults}
        />
      </div>
    </li>
  );
}
