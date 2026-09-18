'use client';

import { cn } from 'cn';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

import { Money } from '@/components/shared/money';
import { addDays, daysBetween } from '@/lib/date-range';

import { minutesLabel, type WaiterReport, type WaiterRow } from '../report';

/**
 * Waiter report (spec §19 Phase 6, feature waiter_reports): the tables each
 * waiter finished, sortable, with a small bar chart of their days
 * (docs/DECISIONS.md P6-7).
 */

type SortKey = 'name' | 'tables' | 'salesPaise' | 'minutes' | 'rounds' | 'items' | 'openTables';

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: 'name', label: 'Waiter', numeric: false },
  { key: 'tables', label: 'Tables', numeric: true },
  { key: 'salesPaise', label: 'Sales', numeric: true },
  { key: 'minutes', label: 'Average time', numeric: true },
  { key: 'rounds', label: 'Rounds', numeric: true },
  { key: 'items', label: 'Dishes', numeric: true },
  { key: 'openTables', label: 'Open now', numeric: true },
];

/** The most days worth drawing side by side; longer ranges show the table only. */
const MAX_CHART_DAYS = 31;

export function WaiterReportView({ report }: { report: WaiterReport }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'tables', desc: true });

  const rows = [...report.waiters].sort((a, b) => {
    const order = compare(a, b, sort.key);
    return sort.desc ? -order : order;
  });

  return (
    <>
      <div className="relative min-w-0 overflow-x-auto">
        <table className="w-full border-collapse text-base">
          <caption className="sr-only">
            Waiters and the tables they billed, sortable by column
          </caption>
          <thead>
            <tr className="border-b border-line text-left text-sm text-ink-muted">
              {COLUMNS.map((column) => {
                const active = sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                    className={cn('py-2 font-medium', column.numeric && 'text-right')}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setSort((current) =>
                          current.key === column.key
                            ? { key: column.key, desc: !current.desc }
                            : { key: column.key, desc: column.numeric },
                        )
                      }
                      className={cn(
                        'inline-flex min-h-8 items-center gap-1 rounded-sm px-1 font-medium',
                        'hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                        active && 'text-ink',
                      )}
                    >
                      {column.label}
                      {active &&
                        (sort.desc ? (
                          <ChevronDown aria-hidden className="size-4" />
                        ) : (
                          <ChevronUp aria-hidden className="size-4" />
                        ))}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((waiter) => (
              <tr key={waiter.waiterId} className="border-b border-line" data-waiter={waiter.name}>
                <th scope="row" className="py-2 text-left font-normal text-ink">
                  {waiter.name}
                  {!waiter.isActive && <span className="text-ink-muted"> · deleted</span>}
                  {waiter.isActive && !waiter.onDuty && (
                    <span className="text-ink-muted"> · off duty</span>
                  )}
                </th>
                <td className="py-2 text-right text-ink tabular-nums">{waiter.tables}</td>
                <td className="py-2 text-right text-ink">
                  <Money paise={waiter.salesPaise} />
                </td>
                <td className="py-2 text-right text-ink tabular-nums">
                  {waiter.tables === 0 ? '—' : minutesLabel(waiter.minutes)}
                </td>
                <td className="py-2 text-right text-ink tabular-nums">{waiter.rounds}</td>
                <td className="py-2 text-right text-ink tabular-nums">{waiter.items}</td>
                <td className="py-2 text-right text-ink tabular-nums">{waiter.openTables}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-ink-muted">
        A table counts for the waiter it was assigned to when the bill was made, so a table handed
        over counts once. Dishes are the ones on those bills.
      </p>
      <WaiterDays report={report} rows={rows} />
    </>
  );
}

function compare(a: WaiterRow, b: WaiterRow, key: SortKey): number {
  if (key === 'name') return a.name.localeCompare(b.name);
  const difference = a[key] - b[key];
  return difference === 0 ? a.name.localeCompare(b.name) : difference;
}

/** One small bar chart per waiter: tables per business day, on a shared scale. */
function WaiterDays({ report, rows }: { report: WaiterReport; rows: WaiterRow[] }) {
  const span = daysBetween(report.from, report.to) + 1;
  const busy = rows.filter((waiter) => waiter.tables > 0).slice(0, 6);
  if (span < 2 || span > MAX_CHART_DAYS || busy.length === 0) return null;

  const dates = Array.from({ length: span }, (_, index) => addDays(report.from, index));
  const counts = new Map(report.days.map((day) => [`${day.waiterId}-${day.date}`, day.tables]));
  const busiest = Math.max(...report.days.map((day) => day.tables), 1);

  return (
    <section aria-labelledby="waiter-days-heading" className="flex min-w-0 flex-col gap-3">
      <h2 id="waiter-days-heading" className="text-base font-semibold text-ink">
        Tables per day
      </h2>
      <ul className="flex min-w-0 flex-col gap-3">
        {busy.map((waiter) => (
          <li key={waiter.waiterId} className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink">{waiter.name}</span>
            <div
              role="img"
              aria-label={`${waiter.name}: ${waiter.tables} tables between ${report.from} and ${report.to}`}
              className="flex h-14 items-end gap-1 border-b border-line"
            >
              {dates.map((date) => {
                const tables = counts.get(`${waiter.waiterId}-${date}`) ?? 0;
                return (
                  <span
                    key={date}
                    title={`${date}: ${tables} ${tables === 1 ? 'table' : 'tables'}`}
                    className="flex h-full flex-1 items-end"
                  >
                    <span
                      className="w-full rounded-t-sm bg-chart-1"
                      style={{ height: `${Math.max(2, (tables / busiest) * 100)}%` }}
                    />
                  </span>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
      <p className="text-sm text-ink-muted">
        {report.from} to {report.to}, on the same scale. Hover a bar for the day.
      </p>
    </section>
  );
}
