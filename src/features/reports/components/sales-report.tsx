import type { ReactNode } from 'react';

import { Money } from '@/components/shared/money';
import { PAYMENT_MODE_LABELS } from '@/features/billing/bill';
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

/** Sales report (spec §13.3, §19 Phase 6): the summary, how it was paid, the
 * day trend and the busy hours. */

export function SalesSummary({ report }: { report: SalesReport }) {
  const s = report.summary;
  const stats: { label: string; value: ReactNode }[] = [
    { label: 'Bills', value: s.bills },
    { label: 'Gross sales', value: <Money paise={s.grossPaise} /> },
    { label: 'Discounts', value: <Money paise={s.discountPaise} /> },
    { label: 'Service charge', value: <Money paise={s.serviceChargePaise} /> },
    { label: 'GST', value: <Money paise={s.taxPaise} /> },
    { label: 'Net sales', value: <Money paise={s.netPaise} /> },
    { label: 'Total billed', value: <Money paise={s.totalPaise} /> },
    { label: 'Average bill', value: <Money paise={s.averagePaise} /> },
  ];

  return (
    <>
      <dl
        aria-label="Summary"
        className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-4"
      >
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col">
            <dt className="text-sm text-ink-muted">{stat.label}</dt>
            <dd className="text-lg font-semibold text-ink tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-ink-muted">
        Net sales is what is left after discounts, including service charge and without GST. Void
        bills are not counted.
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
    <section aria-labelledby="modes-heading" className="flex flex-col gap-2">
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
          <tr>
            <th scope="row" className="py-2 text-left font-normal text-ink">
              Unpaid bills
            </th>
            <td className="py-2 text-right text-ink">
              <Money paise={report.summary.unpaidPaise} />
            </td>
            <td className="py-2 text-right text-ink-muted tabular-nums">
              {report.summary.unpaidBills}
            </td>
          </tr>
        </tbody>
      </table>
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
    <section aria-labelledby="trend-heading" className="flex flex-col gap-2">
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

export function SalesHeatmap({ report }: { report: SalesReport }) {
  const hours = report.hours;
  if (!hours || hours.length === 0) return null;
  const busiest = Math.max(...hours.map((h) => h.totalPaise));
  const cells = new Map(hours.map((h) => [`${h.weekday}-${h.hour}`, h]));
  const columns = hourOrder(report.startHour);

  return (
    <section aria-labelledby="heatmap-heading" className="flex flex-col gap-2">
      <h2 id="heatmap-heading" className="text-base font-semibold text-ink">
        Busy hours
      </h2>
      <p className="text-sm text-ink-muted">
        Bills by the hour they were generated, on the restaurant’s 24-hour clock. Late-night hours
        belong to the day the guests sat down.
      </p>
      <div className="overflow-x-auto">
        <table className="border-collapse text-sm">
          <caption className="sr-only">Sales by weekday and hour, darker cells are busier</caption>
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
                  {hour}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WEEKDAYS.map((weekday, index) => (
              <tr key={weekday}>
                <th scope="row" className="p-1 text-left font-medium text-ink-muted">
                  {WEEKDAYS_SHORT[index]}
                </th>
                {columns.map((hour) => {
                  const cell = cells.get(`${index + 1}-${hour}`);
                  const share = cell && busiest > 0 ? cell.totalPaise / busiest : 0;
                  return (
                    <td key={hour} className="p-0.5">
                      <span
                        title={
                          cell
                            ? `${weekday} ${hourLabel(hour)}: ${cell.bills} ${cell.bills === 1 ? 'bill' : 'bills'}, ${formatINR(cell.totalPaise)}`
                            : `${weekday} ${hourLabel(hour)}: no bills`
                        }
                        className="block size-6 rounded-sm border border-line"
                        style={{
                          backgroundColor: cell
                            ? `color-mix(in oklab, var(--chart-1) ${Math.round(20 + share * 80)}%, var(--surface))`
                            : 'var(--surface)',
                        }}
                      >
                        <span className="sr-only">
                          {weekday} {hourLabel(hour)}:{' '}
                          {cell ? `${cell.bills} bills, ${formatINR(cell.totalPaise)}` : 'no bills'}
                        </span>
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
