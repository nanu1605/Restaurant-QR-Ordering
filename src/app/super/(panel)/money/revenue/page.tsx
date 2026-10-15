import { Download } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Money } from '@/components/shared/money';
import { PageHeader } from '@/components/shared/page-header';
import { buttonVariants } from '@/components/ui/button';
import { DateRangeBar } from '@/features/platform/components/date-range-bar';
import {
  CollectedChart,
  MovementChart,
  MrrChart,
} from '@/features/platform/components/home-charts';
import { ChartPanel } from '@/features/platform/components/home-sections';
import { Section } from '@/features/platform/components/restaurant-sections';
import { formatDate, formatShortDate, todayInIndia } from '@/features/platform/platform';
import {
  CancelReasons,
  Discounts,
  LaunchOffer,
  MovementTable,
  PlanMix,
  RevenueKeyNumbers,
  TrialCohorts,
} from '@/features/revenue/components/revenue-sections';
import { getRevenueMovements, getRevenueReport } from '@/features/revenue/queries';
import {
  bucketEnd,
  eachMovement,
  MOVEMENT_LABELS,
  MOVEMENTS,
  readRevenueParams,
  type Movement,
  type RevenueParams,
} from '@/features/revenue/revenue';
import { previousPeriodLabel, SERIES_BY, type SeriesBy } from '@/features/usage/usage';
import { requirePlatformPermission } from '@/lib/auth/guards';
import { daysBetween, hrefWithParams, platformPresets } from '@/lib/date-range';
import { formatINR } from '@/lib/money';

export const metadata: Metadata = {
  title: 'Revenue',
};

const PATH = '/super/money/revenue';
const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';
const noon = (day: string) => `${day}T12:00:00+05:30`;
const monthLabel = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  month: 'short',
  year: '2-digit',
});
const SERIES_LABELS: Record<SeriesBy, string> = { day: 'Days', week: 'Weeks', month: 'Months' };
const SERIES_UNITS: Record<SeriesBy, string> = {
  day: 'day',
  week: 'week from Monday',
  month: 'month',
};

/** The page's own params, without the movement list unless given. */
function revenueParams(params: RevenueParams, next: Partial<RevenueParams> = {}) {
  const merged = { ...params, ...next };
  return {
    from: merged.from,
    to: merged.to,
    compare: merged.compare ? '1' : undefined,
    by: merged.by,
    move: merged.move,
    at: merged.move ? merged.at : undefined,
  };
}

/**
 * Revenue analytics (docs/SUPER_ADMIN_PLAN.md 13f and §5.2 to §5.9,
 * docs/DECISIONS.md SA-65+): what restaurants pay MenuMesh, how MRR moved and
 * why, by India date. Amounts exclude GST unless marked.
 */
export default async function RevenuePage({ searchParams }: PageProps<'/super/money/revenue'>) {
  await requirePlatformPermission('money.view');
  const today = todayInIndia();
  const params = readRevenueParams(await searchParams, today);
  const { from, to, by } = params;
  const moveFrom = params.at ?? from;
  const moveTo = params.at ? bucketEnd(params.at, by, to) : to;
  const [report, moved] = await Promise.all([
    getRevenueReport(from, to, by, params.compare),
    params.move ? getRevenueMovements(moveFrom, moveTo, params.move) : null,
  ]);
  const period = previousPeriodLabel(daysBetween(from, to) + 1);
  const hrefFor = (next: Partial<RevenueParams>) =>
    hrefWithParams(PATH, revenueParams(params, next));
  const historyNote = report.history_starts_on
    ? `MRR history starts on ${formatDate(noon(report.history_starts_on))}, when daily snapshots began.`
    : 'MRR history starts with the first nightly snapshot, at 3 am.';
  const wholeMonth = (start: string) => by === 'month' && start.endsWith('-01');
  const pointLabel = (start: string) =>
    wholeMonth(start) ? monthLabel.format(new Date(noon(start))) : formatShortDate(noon(start));
  const rowLabel = (start: string) =>
    wholeMonth(start)
      ? monthLabel.format(new Date(noon(start)))
      : by === 'month'
        ? `From ${formatDate(noon(start))}`
        : formatDate(noon(start));
  const firstColumn = by === 'day' ? 'Day' : by === 'week' ? 'Week from' : 'Month';
  const withHistory = report.series.filter((point) => point.mrr_paise !== null);
  const historyCut =
    report.history_starts_on !== null && report.history_starts_on > from ? historyNote : null;
  const moveHref = (kind: Movement, at?: string) => `${hrefFor({ move: kind, at })}#movements`;

  return (
    <>
      <PageHeader
        title="Revenue"
        description="What restaurants pay MenuMesh, by India date. Amounts are before GST unless marked; GMV is on Usage."
        actions={
          <a
            href={hrefWithParams(`${PATH}/export`, { from, to, by })}
            download
            className={buttonVariants({ variant: 'outline', size: 'touch' })}
          >
            <Download aria-hidden />
            Export CSV
          </a>
        }
      />
      <DateRangeBar
        path={PATH}
        presets={platformPresets(today)}
        from={from}
        to={to}
        compare={params.compare}
        notice={params.notice}
      />
      {report.previous_from && report.previous_to && (
        <p className="text-sm text-ink-muted">
          Compared with {formatDate(noon(report.previous_from))} to{' '}
          {formatDate(noon(report.previous_to))}.
        </p>
      )}
      {historyCut && <p className="text-sm text-ink-muted">{historyCut}</p>}

      <RevenueKeyNumbers
        report={report}
        period={period}
        historyNote={historyNote}
        live={to === today}
        churnHref={moveHref('churn')}
      />

      <ChartPanel
        id="chart-revenue-mrr"
        title="MRR"
        description={`MRR before GST at the end of each ${SERIES_UNITS[by]}. ${historyNote}`}
        // A line needs two points; one alone draws nothing.
        empty={
          withHistory.length === 0
            ? historyNote
            : withHistory.length === 1
              ? 'One bar only: choose more dates, or days or weeks, to see MRR move.'
              : null
        }
        action={
          <nav aria-label="Group by" className="flex gap-2">
            {SERIES_BY.map((next) => (
              <Link
                key={next}
                href={hrefFor({ by: next, move: undefined })}
                aria-current={by === next ? 'page' : undefined}
                className={buttonVariants({
                  variant: by === next ? 'default' : 'outline',
                  size: 'sm',
                })}
              >
                {SERIES_LABELS[next]}
              </Link>
            ))}
          </nav>
        }
        chart={
          <MrrChart
            points={withHistory.map((point) => ({
              label: pointLabel(point.start),
              title: `MRR on ${formatDate(noon(point.end))}`,
              mrrPaise: point.mrr_paise ?? 0,
            }))}
            summary={
              report.totals.mrr_paise === null
                ? historyNote
                : `MRR from ${formatDate(noon(from))} to ${formatDate(noon(to))}, ending at ${formatINR(report.totals.mrr_paise)}.`
            }
          />
        }
        table={{
          headers: [firstColumn, 'MRR at the end', 'Paid at the end'],
          rows: withHistory.map((point) => [
            rowLabel(point.start),
            <Money key="mrr" paise={point.mrr_paise ?? 0} fraction="auto" />,
            (point.paid ?? 0).toLocaleString('en-IN'),
          ]),
        }}
      />

      <ChartPanel
        id="chart-revenue-movement"
        title="MRR movement"
        description="New, reactivated and expanded MRR above the line; contraction and churn below. Choose a bar, or a figure in its table, to see its restaurants. A failed payment counts as churn until the restaurant pays again."
        empty={withHistory.length === 0 ? historyNote : null}
        chart={
          <MovementChart
            points={withHistory.map((point) => ({
              label: pointLabel(point.start),
              ...eachMovement((kind) => point.movements[kind].paise),
              hrefs: eachMovement((kind) => moveHref(kind, point.start)),
            }))}
            summary={`MRR movement from ${formatDate(noon(from))} to ${formatDate(noon(to))}: ${MOVEMENTS.map((kind) => `${MOVEMENT_LABELS[kind]} ${formatINR(report.totals.movements[kind].paise, { signDisplay: 'exceptZero' })}`).join(', ')}.`}
          />
        }
        table={{
          headers: [firstColumn, ...MOVEMENTS.map((kind) => MOVEMENT_LABELS[kind])],
          rows: withHistory.map((point) => [
            rowLabel(point.start),
            ...MOVEMENTS.map((kind) => {
              const { count, paise } = point.movements[kind];
              return count === 0 ? (
                '—'
              ) : (
                <Link key={kind} href={moveHref(kind, point.start)} className={linkClass}>
                  {count.toLocaleString('en-IN')},{' '}
                  <Money paise={paise} fraction="auto" signDisplay="exceptZero" />
                </Link>
              );
            }),
          ]),
        }}
      />

      {params.move && moved && (
        <div id="movements" className="scroll-mt-4">
          <Section
            title={`${MOVEMENT_LABELS[params.move]}, ${moveFrom === moveTo ? formatDate(noon(moveFrom)) : `${formatDate(noon(moveFrom))} to ${formatDate(noon(moveTo))}`}`}
            action={
              <Link
                href={`${hrefFor({ move: undefined })}#chart-revenue-movement`}
                className={`text-sm ${linkClass}`}
              >
                Hide the list
              </Link>
            }
          >
            <nav aria-label="Movement" className="flex flex-wrap gap-2">
              {MOVEMENTS.map((kind) => (
                <Link
                  key={kind}
                  href={moveHref(kind, params.at)}
                  aria-current={params.move === kind ? 'page' : undefined}
                  className={buttonVariants({
                    variant: params.move === kind ? 'default' : 'outline',
                    size: 'sm',
                  })}
                >
                  {MOVEMENT_LABELS[kind]}
                </Link>
              ))}
            </nav>
            <MovementTable list={moved} label={`${MOVEMENT_LABELS[params.move]} restaurants`} />
          </Section>
        </div>
      )}

      <ChartPanel
        id="chart-revenue-collected"
        title="Collected"
        description={`Payments received by ${SERIES_UNITS[by]}, before GST; GST is in the table.`}
        empty={report.totals.collected.count === 0 ? 'No payments in these dates.' : null}
        chart={
          <CollectedChart
            points={report.series.map((point) => ({
              label: pointLabel(point.start),
              subscription: point.subscription_base_paise,
              setupFee: point.setup_fee_base_paise,
            }))}
            summary={`Collected from ${formatDate(noon(from))} to ${formatDate(noon(to))}: subscriptions ${formatINR(report.totals.collected.subscription_base_paise)}, setup fees ${formatINR(report.totals.collected.setup_fee_base_paise)}, before GST.`}
          />
        }
        table={{
          headers: [firstColumn, 'Subscriptions', 'Setup fees', 'GST', 'Total with GST'],
          rows: report.series.map((point) => [
            rowLabel(point.start),
            <Money key="sub" paise={point.subscription_base_paise} fraction="auto" />,
            <Money key="setup" paise={point.setup_fee_base_paise} fraction="auto" />,
            <Money key="gst" paise={point.gst_paise} fraction="auto" />,
            <Link
              key="total"
              href={hrefWithParams('/super/money/payments', { from: point.start, to: point.end })}
              className={linkClass}
            >
              <Money
                paise={point.subscription_base_paise + point.setup_fee_base_paise + point.gst_paise}
                fraction="auto"
              />
            </Link>,
          ]),
        }}
      />

      {/* Five columns in the plan mix: side by side only on the widest screens. */}
      <div className="grid gap-4 2xl:grid-cols-2">
        <PlanMix report={report} live={to === today} historyNote={historyNote} />
        <CancelReasons report={report} />
        <LaunchOffer report={report} />
        <Discounts report={report} />
      </div>
      <TrialCohorts cohorts={report.cohorts} />
    </>
  );
}
