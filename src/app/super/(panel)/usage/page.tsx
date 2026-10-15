import type { Metadata } from 'next';
import Link from 'next/link';

import { Money } from '@/components/shared/money';
import { PageHeader } from '@/components/shared/page-header';
import { buttonVariants } from '@/components/ui/button';
import { DateRangeBar } from '@/features/platform/components/date-range-bar';
import { Heatmap } from '@/features/platform/components/heatmap';
import { UsageChart } from '@/features/platform/components/home-charts';
import { ChartPanel } from '@/features/platform/components/home-sections';
import { Section } from '@/features/platform/components/restaurant-sections';
import { formatDate, formatShortDate } from '@/features/platform/platform';
import {
  BillsSection,
  FeatureAdoption,
  GroupTable,
  RankedTable,
  restaurantsHref,
  UsageKeyNumbers,
} from '@/features/usage/components/usage-sections';
import { getUsageReport } from '@/features/usage/queries';
import {
  businessTodayInIndia,
  groupSeries,
  previousPeriodLabel,
  rankGroups,
  readUsageParams,
  SERIES_BY,
  type SeriesBy,
  type UsageParams,
} from '@/features/usage/usage';
import { requirePlatformPermission } from '@/lib/auth/guards';
import { datePresets, daysBetween, hrefWithParams, platformPresets } from '@/lib/date-range';
import { formatINR } from '@/lib/money';

export const metadata: Metadata = {
  title: 'Usage',
};

const PATH = '/super/usage';
const noon = (day: string) => `${day}T12:00:00+05:30`;
const monthLabel = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  month: 'short',
  year: '2-digit',
});
const SERIES_LABELS: Record<SeriesBy, string> = { day: 'Days', week: 'Weeks', month: 'Months' };
const SERIES_UNITS: Record<SeriesBy, string> = {
  day: 'business day',
  week: 'week from Monday',
  month: 'month',
};

function usageHref(params: UsageParams, next: Partial<UsageParams>) {
  const merged = { ...params, ...next };
  return hrefWithParams(PATH, {
    from: merged.from,
    to: merged.to,
    compare: merged.compare ? '1' : undefined,
    by: merged.by,
    rank: merged.rank === 'gmv' ? undefined : merged.rank,
  });
}

/**
 * Usage analytics (docs/SUPER_ADMIN_PLAN.md 13e and §5.10, docs/DECISIONS.md
 * SA-61 to SA-64): what diners paid and ordered on MenuMesh over each
 * restaurant's business days, where, on which plans, and which features the
 * Paid restaurants use.
 */
export default async function UsagePage({ searchParams }: PageProps<'/super/usage'>) {
  await requirePlatformPermission('insights.view');
  const today = businessTodayInIndia();
  const params = readUsageParams(await searchParams, today);
  const { from, to } = params;
  const report = await getUsageReport(from, to, params.compare);
  const days = daysBetween(from, to) + 1;
  const period = previousPeriodLabel(days);
  const points = groupSeries(report.days, from, to, params.by);
  const total = report.totals.gmv_paise;
  const pointLabel = (start: string) =>
    params.by === 'month' ? monthLabel.format(new Date(noon(start))) : formatShortDate(noon(start));
  const presets = [
    ...datePresets(today).filter((preset) => preset.key !== 'month'),
    ...platformPresets(today),
  ];
  const fewActive = report.totals.active <= 10;

  return (
    <>
      <PageHeader
        title="Usage"
        description="What diners paid and ordered on MenuMesh, by each restaurant’s business days. GMV is diners’ bills with the restaurants’ taxes, never MenuMesh revenue."
      />
      <DateRangeBar
        path={PATH}
        presets={presets}
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

      <UsageKeyNumbers report={report} period={period} />

      <ChartPanel
        id="chart-usage-series"
        title="GMV and orders"
        description={`What diners paid (taxes included) and accepted orders, by ${SERIES_UNITS[params.by]}.`}
        empty={report.totals.orders + total === 0 ? 'No orders in these dates.' : null}
        action={
          <nav aria-label="Group by" className="flex gap-2">
            {SERIES_BY.map((by) => (
              <Link
                key={by}
                href={usageHref(params, { by })}
                aria-current={params.by === by ? 'page' : undefined}
                className={buttonVariants({
                  variant: params.by === by ? 'default' : 'outline',
                  size: 'sm',
                })}
              >
                {SERIES_LABELS[by]}
              </Link>
            ))}
          </nav>
        }
        chart={
          <UsageChart
            points={points.map((point) => ({
              label: pointLabel(point.start),
              gmvPaise: point.gmvPaise,
              orders: point.orders,
            }))}
            summary={`GMV and orders from ${formatDate(noon(from))} to ${formatDate(noon(to))}: ${formatINR(total)} and ${report.totals.orders.toLocaleString('en-IN')} orders.`}
          />
        }
        table={{
          headers: [
            params.by === 'day' ? 'Day' : params.by === 'week' ? 'Week from' : 'Month',
            'GMV',
            'Orders',
          ],
          rows: points.map((point) => [
            params.by === 'month'
              ? monthLabel.format(new Date(noon(point.start)))
              : formatDate(noon(point.start)),
            <Money key="gmv" paise={point.gmvPaise} fraction="auto" />,
            point.orders.toLocaleString('en-IN'),
          ]),
        }}
      />

      <div className="flex flex-col gap-3">
        <nav aria-label="Rank places and plans by" className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink-muted">Rank by</span>
          {(
            [
              ['gmv', 'GMV'],
              ['restaurants', 'Restaurants'],
            ] as const
          ).map(([rank, label]) => (
            <Link
              key={rank}
              href={usageHref(params, { rank })}
              aria-current={params.rank === rank ? 'page' : undefined}
              className={buttonVariants({
                variant: params.rank === rank ? 'default' : 'outline',
                size: 'sm',
              })}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="grid gap-4 xl:grid-cols-2">
          <GroupTable
            title="By city"
            what="City"
            groups={rankGroups(report.by_city, params.rank)}
            total={total}
            href={(group) => restaurantsHref('city', group.name)}
            unknown="Not given"
          />
          <GroupTable
            title="By state"
            what="State"
            groups={rankGroups(report.by_state, params.rank)}
            total={total}
            href={(group) => restaurantsHref('region', group.name)}
            unknown="Not given"
          />
          <GroupTable
            title="By plan"
            what="Plan"
            groups={rankGroups(report.by_plan, params.rank)}
            total={total}
            href={(group) => restaurantsHref('plan', group.code)}
            unknown="No plan"
          />
          <BillsSection report={report} />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <RankedTable title="Top 10 by GMV" rows={report.top_gmv} measure="gmv" total={total} />
        <RankedTable
          title="Top 10 by orders"
          rows={report.top_orders}
          measure="orders"
          total={report.totals.orders}
        />
        {!fewActive && (
          <>
            <RankedTable
              title="Bottom 10 by GMV"
              rows={report.bottom_gmv}
              measure="gmv"
              total={total}
            />
            <RankedTable
              title="Bottom 10 by orders"
              rows={report.bottom_orders}
              measure="orders"
              total={report.totals.orders}
            />
          </>
        )}
      </div>
      {fewActive && report.totals.active > 0 && (
        <p className="text-sm text-ink-muted">
          No bottom 10: every restaurant with an order is in the top lists.
        </p>
      )}

      <Section title="Busy hours">
        <p className="text-sm text-ink-muted">
          Accepted orders by weekday and hour on each restaurant’s clock. Late-night hours belong to
          the business day they started in.
        </p>
        {report.hours.length === 0 ? (
          <p className="text-sm text-ink-muted">No orders in these dates.</p>
        ) : (
          <Heatmap
            label="Orders by weekday and hour"
            cells={report.hours.map((cell) => ({
              weekday: cell.weekday,
              hour: cell.hour,
              value: cell.orders,
            }))}
            startHour={4}
            describe={(orders) =>
              `${orders.toLocaleString('en-IN')} ${orders === 1 ? 'order' : 'orders'}`
            }
          />
        )}
      </Section>

      <FeatureAdoption features={report.features} />
    </>
  );
}
