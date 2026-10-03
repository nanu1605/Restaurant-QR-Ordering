import type { ReactNode } from 'react';

import { Money } from '@/components/shared/money';
import { PAYMENT_MODE_LABELS } from '@/features/billing/bill';
import { addDays, daysBetween } from '@/lib/date-range';
import { formatINR } from '@/lib/money';

import {
  type Collected,
  hourLabel,
  hourOrder,
  type SalesReport,
  WEEKDAYS,
  WEEKDAYS_SHORT,
} from '../report';
import { SalesTrendChart, type TrendPoint } from './sales-trend-chart';
import { ScrollRegion } from '@/components/shared/scroll-region';

/** Sales report (spec §13.3, §19 Phase 6): the summary, how it was paid, the
 * day trend and the busy hours. */

export function SalesSummary({ report }: { report: SalesReport }) {
  const s = report.summary;
  const stats: { label: string; value: ReactNode }[] = [
    { label: 'Bills', value: s.bills },
    { label: 'Gross sales', value: <Money paise={s.grossPaise} /> },
    { label: 'Discounts', value: <Money paise={s.discountPaise} /> },
    { label: 'Service charge', value: <Money paise={s.serviceChargePaise} /> },
    { label: 'Net sales', value: <Money paise={s.netPaise} /> },
    { label: 'GST', value: <Money paise={s.taxPaise} /> },
    { label: 'Round off', value: <Money paise={s.roundOffPaise} signDisplay="exceptZero" /> },
    { label: 'Total billed', value: <Money paise={s.totalPaise} /> },
    { label: 'Average bill', value: <Money paise={s.averagePaise} /> },
  ];

  return (
    <>
      <dl
        aria-label="Summary"
        className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-3"
      >
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col">
            <dt className="text-sm text-ink-muted">{stat.label}</dt>
            <dd className="text-lg font-semibold text-ink tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-ink-muted">
        Net sales is what is left after discounts, including service charge and without GST; net
        sales, GST and round off add up to the total billed. Void bills are not counted.
      </p>
    </>
  );
}

const MODES: (keyof Collected)[] = ['cash', 'upi', 'card', 'other'];

export function PaymentModes({ report }: { report: SalesReport }) {
  const collected = report.summary.collected;
  if (!collected) return null;
  const total = MODES.reduce((sum, mode) => sum + collected[mode], 0);

  return (
    <section aria-labelledby="modes-heading" className="flex min-w-0 flex-col gap-2">
      <h2 id="modes-heading" className="text-base font-semibold text-ink">
        How it was paid
      </h2>
      <table className="w-full border-collapse text-base">
        <thead>
          <tr className="border-b border-line text-left text-sm text-ink-muted">
            <th scope="col" className="py-2 font-medium">
              Mode
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Collected
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {MODES.map((mode) => (
            <tr key={mode} className="border-b border-line">
              <th scope="row" className="py-2 text-left font-normal text-ink">
                {PAYMENT_MODE_LABELS[mode]}
              </th>
              <td className="py-2 text-right text-ink">
                <Money paise={collected[mode]} />
              </td>
              <td className="py-2 text-right text-ink-muted tabular-nums">
                {total === 0 ? '—' : `${Math.round((collected[mode] / total) * 100)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-sm text-ink">
        {report.summary.unpaidBills === 0 ? (
          'Every bill is paid.'
        ) : (
          <>
            {report.summary.unpaidBills} {report.summary.unpaidBills === 1 ? 'bill' : 'bills'} not
            paid yet: <Money paise={report.summary.unpaidPaise} />.
          </>
        )}
      </p>
    </section>
  );
}

function dayLabel(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}/${month}`;
}

export function SalesTrend({ report }: { report: SalesReport }) {
  const days = report.days;
  if (!days || days.length < 2) return null;
  const points: TrendPoint[] = days.map((day) => ({
    label: dayLabel(day.date),
    title: day.date,
    totalPaise: day.totalPaise,
    bills: day.bills,
  }));
  const best = days.reduce((top, day) => (day.totalPaise > top.totalPaise ? day : top), days[0]!);

  return (
    <section aria-labelledby="trend-heading" className="flex min-w-0 flex-col gap-2">
      <h2 id="trend-heading" className="text-base font-semibold text-ink">
        Day by day
      </h2>
      <SalesTrendChart
        points={points}
        summary={`Total billed per business day from ${report.from} to ${report.to}. Best day ${best.date} at ${formatINR(best.totalPaise)}.`}
      />
      <details className="text-base text-ink">
        <summary className="cursor-pointer text-sm text-ink-muted">Show the numbers</summary>
        <table className="mt-2 w-full border-collapse text-base">
          <thead>
            <tr className="border-b border-line text-left text-sm text-ink-muted">
              <th scope="col" className="py-2 font-medium">
                Day
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Bills
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Total billed
              </th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date} className="border-b border-line">
                <th scope="row" className="py-2 text-left font-normal">
                  {day.date}
                </th>
                <td className="py-2 text-right tabular-nums">{day.bills}</td>
                <td className="py-2 text-right">
                  <Money paise={day.totalPaise} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

/** ISO weekday (1 = Monday) of a 'YYYY-MM-DD' business date. */
function isoWeekday(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

/** The weekdays a range covers, Monday first; all seven from a week up. */
function weekdaysIn(from: string, to: string): number[] {
  const span = daysBetween(from, to) + 1;
  if (span >= 7) return [1, 2, 3, 4, 5, 6, 7];
  const covered = new Set(Array.from({ length: span }, (_, i) => isoWeekday(addDays(from, i))));
  return [1, 2, 3, 4, 5, 6, 7].filter((weekday) => covered.has(weekday));
}

/** Cell fill: the quietest hour at 30% of the chart hue, the busiest at full strength. */
function cellColor(share: number): string {
  return `color-mix(in oklab, var(--chart-1) ${Math.round(30 + share * 70)}%, var(--surface))`;
}

export function SalesHeatmap({ report }: { report: SalesReport }) {
  const hours = report.hours;
  if (!hours || hours.length === 0) return null;
  const busiest = Math.max(...hours.map((h) => h.totalPaise));
  const quietest = Math.min(...hours.map((h) => h.totalPaise));
  const cells = new Map(hours.map((h) => [`${h.weekday}-${h.hour}`, h]));
  const columns = hourOrder(report.startHour);
  const rows = weekdaysIn(report.from, report.to);
  const ranked = [...hours].sort(
    (a, b) => b.totalPaise - a.totalPaise || a.weekday - b.weekday || a.hour - b.hour,
  );

  return (
    <section aria-labelledby="heatmap-heading" className="flex min-w-0 flex-col gap-2">
      <h2 id="heatmap-heading" className="text-base font-semibold text-ink">
        Busy hours
      </h2>
      <p className="text-sm text-ink-muted">
        Bills by the hour they were generated, on the restaurant’s 24-hour clock. Late-night hours
        belong to the day the guests sat down.
      </p>
      <ScrollRegion label="Busy hours grid">
        <table className="border-collapse text-sm">
          <caption className="sr-only">
            Bills and sales by weekday and hour; darker cells are busier
          </caption>
          <thead>
            <tr>
              <th scope="col" className="p-1 text-left font-medium text-ink-muted">
                Day
              </th>
              {columns.map((hour) => (
                <th
                  key={hour}
                  scope="col"
                  className="p-1 text-center text-xs font-medium text-ink-muted"
                >
                  <span aria-hidden>{hour}</span>
                  <span className="sr-only">{hourLabel(hour)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((weekday) => (
              <tr key={weekday}>
                <th scope="row" className="p-1 text-left font-medium text-ink-muted">
                  <span aria-hidden>{WEEKDAYS_SHORT[weekday - 1]}</span>
                  <span className="sr-only">{WEEKDAYS[weekday - 1]}</span>
                </th>
                {columns.map((hour) => {
                  const cell = cells.get(`${weekday}-${hour}`);
                  const share = cell && busiest > 0 ? cell.totalPaise / busiest : 0;
                  return (
                    <td key={hour} className="p-0.5">
                      <span
                        title={
                          cell
                            ? `${WEEKDAYS[weekday - 1]} ${hourLabel(hour)}: ${cell.bills} ${cell.bills === 1 ? 'bill' : 'bills'}, ${formatINR(cell.totalPaise)}`
                            : undefined
                        }
                        className="relative block size-6 rounded-sm border border-line"
                        style={{ backgroundColor: cell ? cellColor(share) : 'var(--surface)' }}
                      >
                        {cell && (
                          <span className="sr-only">
                            {cell.bills} {cell.bills === 1 ? 'bill' : 'bills'},{' '}
                            {formatINR(cell.totalPaise)}
                          </span>
                        )}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <div aria-hidden className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <span>Quieter</span>
        {[0, 0.33, 0.66, 1].map((share) => (
          <span
            key={share}
            className="block size-4 rounded-sm border border-line"
            style={{ backgroundColor: cellColor(share) }}
          />
        ))}
        <span>Busier</span>
        <span className="tabular-nums">
          ({formatINR(quietest)} to {formatINR(busiest)} in an hour)
        </span>
      </div>
      <details className="text-base text-ink">
        <summary className="cursor-pointer text-sm text-ink-muted">Show the numbers</summary>
        <table className="mt-2 w-full border-collapse text-base">
          <caption className="sr-only">Busy hours, busiest first</caption>
          <thead>
            <tr className="border-b border-line text-left text-sm text-ink-muted">
              <th scope="col" className="py-2 font-medium">
                Day and hour
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Bills
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Total billed
              </th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((cell) => (
              <tr key={`${cell.weekday}-${cell.hour}`} className="border-b border-line">
                <th scope="row" className="py-2 text-left font-normal">
                  {WEEKDAYS[cell.weekday - 1]} {hourLabel(cell.hour)}
                </th>
                <td className="py-2 text-right tabular-nums">{cell.bills}</td>
                <td className="py-2 text-right">
                  <Money paise={cell.totalPaise} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
