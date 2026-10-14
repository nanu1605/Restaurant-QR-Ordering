import { ArrowDown, ArrowUp } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Money } from '@/components/shared/money';
import { buttonVariants } from '@/components/ui/button';
import { hrefWithParams } from '@/lib/date-range';

import {
  ACTIVITY_KIND_LABELS,
  ACTIVITY_KINDS,
  activityLine,
  amountWithGst,
  mrrChange,
  type ActivityKind,
  type ActivityPage,
  type Home,
} from '../home';
import type { HomeParams } from '../params';
import { formatDate, formatDateTime } from '../platform';

const linkClass = 'underline-offset-4 hover:underline';

function homeHref(params: HomeParams, next: Partial<HomeParams>) {
  const merged = { ...params, ...next };
  return hrefWithParams('/super', {
    period: merged.period === 'today' ? undefined : merged.period,
    kind: merged.kind,
    before: merged.before,
  });
}

function Figure({
  label,
  href,
  children,
  note,
}: {
  label: string;
  href?: string;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-sm text-ink-muted">
        {href ? (
          <Link href={href} className={linkClass}>
            {label}
          </Link>
        ) : (
          label
        )}
      </dt>
      <dd className="text-xl font-semibold text-ink tabular-nums">{children}</dd>
      {note && <dd className="text-xs text-ink-muted">{note}</dd>}
    </div>
  );
}

/**
 * Key numbers (docs/SUPER_ADMIN_PLAN.md 12e, docs/DECISIONS.md SA-27): one
 * compact strip, each figure a link to the rows behind it. MenuMesh money
 * and GMV are never added together.
 */
export function KeyNumbers({
  home,
  params,
  today,
}: {
  home: Home;
  params: HomeParams;
  today: string;
}) {
  const month = home.period === 'month';
  const change =
    home.mrr_paise === null ? null : mrrChange(home.mrr_paise, home.mrr_month_ago_paise);

  return (
    <section aria-labelledby="numbers-heading" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="numbers-heading" className="text-lg font-semibold text-ink">
          Key numbers
        </h2>
        <nav aria-label="Period" className="flex gap-2">
          {(['today', 'month'] as const).map((period) => (
            <Link
              key={period}
              href={homeHref(params, { period, before: undefined })}
              aria-current={home.period === period ? 'page' : undefined}
              className={buttonVariants({
                variant: home.period === period ? 'default' : 'outline',
                size: 'touch',
              })}
            >
              {period === 'today' ? 'Today' : 'This month'}
            </Link>
          ))}
        </nav>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg border border-line bg-surface p-4 sm:grid-cols-4 xl:grid-cols-8">
        {home.mrr_paise !== null && (
          <Figure
            label="MRR"
            href="/super/money/subscriptions?state=paid"
            note={
              change === null ? (
                'Before GST'
              ) : (
                <span className="inline-flex items-center gap-0.5">
                  {change >= 0 ? (
                    <ArrowUp aria-hidden className="size-3" />
                  ) : (
                    <ArrowDown aria-hidden className="size-3" />
                  )}
                  {change >= 0 ? 'Up' : 'Down'} {Math.abs(change)}% in a month
                </span>
              )
            }
          >
            <Money paise={home.mrr_paise} fraction="auto" />
          </Figure>
        )}
        {home.collected && (
          <Figure
            label={month ? 'Collected this month' : 'Collected today'}
            href={
              month
                ? '/super/money/payments'
                : hrefWithParams('/super/money/payments', { from: today, to: today })
            }
            note={
              <>
                + GST <Money paise={home.collected.gst_paise} fraction="auto" />,{' '}
                {home.collected.count} {home.collected.count === 1 ? 'payment' : 'payments'}
              </>
            }
          >
            <Money paise={home.collected.base_paise} fraction="auto" />
          </Figure>
        )}
        <Figure label="Paid" href="/super/money/subscriptions?state=paid">
          {home.restaurants.paid}
        </Figure>
        <Figure label="On trial" href="/super/money/subscriptions?state=trial">
          {home.restaurants.trial}
        </Figure>
        <Figure label="Payment failed" href="/super/money/dues?bucket=payment_failed">
          {home.restaurants.payment_failed}
        </Figure>
        <Figure
          label={month ? 'GMV this month' : 'GMV today'}
          href="/super/restaurants?sort=gmv"
          note="Diners' bills, taxes included"
        >
          <Money paise={home.gmv_paise} fraction="auto" />
        </Figure>
        <Figure
          label={month ? 'Orders this month' : 'Orders today'}
          href="/super/restaurants?sort=gmv"
        >
          {home.orders.toLocaleString('en-IN')}
        </Figure>
        <Figure label="Open tables now">{home.open_tables.toLocaleString('en-IN')}</Figure>
      </dl>
      <p className="text-xs text-ink-muted">
        {month
          ? 'This month: payments by India date; orders and GMV by each restaurant’s business days.'
          : 'Today: payments since midnight in India; orders and GMV in each restaurant’s current business day.'}
      </p>
    </section>
  );
}

/**
 * A chart with its title, what it shows, when its data starts and the
 * numbers as a table (docs/SUPER_ADMIN_PLAN.md §1).
 */
export function ChartPanel({
  id,
  title,
  description,
  empty,
  chart,
  table,
}: {
  id: string;
  title: string;
  description: string;
  /** Shown instead of the chart while there is nothing to draw. */
  empty: string | null;
  chart: ReactNode;
  table: { headers: string[]; rows: ReactNode[][] };
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3"
    >
      <h2 id={id} className="text-base font-semibold text-ink">
        {title}
      </h2>
      <p className="text-sm text-ink-muted">{description}</p>
      {empty ? (
        <p className="flex h-56 items-center justify-center rounded-md border border-dashed border-line px-4 text-center text-sm text-ink-muted">
          {empty}
        </p>
      ) : (
        <>
          {chart}
          <details className="text-sm text-ink">
            <summary className="cursor-pointer text-ink-muted">Show as a table</summary>
            <div className="mt-2 max-h-72 overflow-y-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-line text-left text-ink-muted">
                    {table.headers.map((header, index) => (
                      <th
                        key={header}
                        scope="col"
                        className={`py-1.5 font-medium ${index > 0 ? 'text-right' : ''}`}
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-b border-line">
                      {row.map((cell, index) =>
                        index === 0 ? (
                          <th key={index} scope="row" className="py-1.5 text-left font-normal">
                            {cell}
                          </th>
                        ) : (
                          <td key={index} className="py-1.5 text-right tabular-nums">
                            {cell}
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

/** The activity stream (docs/SUPER_ADMIN_PLAN.md §4.5, docs/DECISIONS.md SA-29). */
export function ActivityFeed({
  page,
  params,
  kinds,
}: {
  page: ActivityPage;
  params: HomeParams;
  /** The kinds this admin may see. */
  kinds: readonly ActivityKind[];
}) {
  return (
    <section id="activity" aria-labelledby="activity-heading" className="flex flex-col gap-3">
      <h2 id="activity-heading" className="text-lg font-semibold text-ink">
        Activity
      </h2>
      <nav aria-label="Activity kinds" className="flex flex-wrap gap-2">
        {[undefined, ...ACTIVITY_KINDS.filter((kind) => kinds.includes(kind))].map((kind) => (
          <Link
            key={kind ?? 'all'}
            href={`${homeHref(params, { kind, before: undefined })}#activity`}
            aria-current={params.kind === kind ? 'page' : undefined}
            className={buttonVariants({
              variant: params.kind === kind ? 'default' : 'outline',
              className: 'h-11 md:h-8',
            })}
          >
            {kind ? ACTIVITY_KIND_LABELS[kind] : 'All'}
          </Link>
        ))}
      </nav>
      {page.items.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface p-3 text-sm text-ink-muted">
          {params.before ? 'Nothing older.' : 'Nothing here yet.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {page.items.map((item) => {
            const line = activityLine(item);
            const lapsed = item.kind === 'lapsed';
            return (
              <li
                key={item.key}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2"
              >
                <time
                  dateTime={item.at}
                  className="w-32 shrink-0 text-sm text-ink-muted tabular-nums"
                >
                  {lapsed && typeof item.data.day === 'string'
                    ? formatDate(item.data.day)
                    : formatDateTime(item.at)}
                </time>
                <div className="flex min-w-0 flex-1 basis-60 flex-col">
                  <p className="text-sm text-ink">
                    {line.href ? (
                      <Link
                        href={line.href}
                        className="font-medium text-brand underline-offset-4 hover:underline"
                      >
                        {line.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{line.title}</span>
                    )}
                    {item.restaurant_name && <> · {item.restaurant_name}</>}
                  </p>
                  {line.detail && <p className="text-sm text-ink-muted">{line.detail}</p>}
                </div>
                {line.amount && (
                  <p className="text-sm text-ink tabular-nums">{amountWithGst(line.amount)}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex gap-2">
        {params.before && (
          <Link
            href={`${homeHref(params, { before: undefined })}#activity`}
            className={buttonVariants({ variant: 'outline', size: 'touch' })}
          >
            Newest
          </Link>
        )}
        {page.next && (
          <Link
            href={`${homeHref(params, { before: page.next })}#activity`}
            className={buttonVariants({ variant: 'outline', size: 'touch' })}
          >
            Older
          </Link>
        )}
      </div>
    </section>
  );
}
