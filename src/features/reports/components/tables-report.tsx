import { Money } from '@/components/shared/money';
import { tableHeading } from '@/features/ordering/format';

import { minutesLabel, type TablesReport } from '../report';
import { ScrollRegion } from '@/components/shared/scroll-region';

/** Table turnover (spec §19 Phase 6): how often each table filled and for how long. */
export function TablesReportView({ report }: { report: TablesReport }) {
  const { overall } = report;

  return (
    <>
      <dl
        aria-label="Turnover"
        className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-4"
      >
        <Stat label="Tables billed" value={overall.sessions} />
        <Stat label="Average table time" value={minutesLabel(overall.minutes)} />
        <Stat label="Sales" value={<Money paise={overall.totalPaise} />} />
        <Stat label="Sittings per table" value={overall.perTable.toFixed(2)} />
      </dl>
      <p className="text-sm text-ink-muted">
        Table time runs from the first order until the bill, so a table reopened after a void counts
        its whole stay.
      </p>

      <ScrollRegion label="Tables">
        <table className="w-full border-collapse text-base">
          <caption className="sr-only">Tables, busiest first</caption>
          <thead>
            <tr className="border-b border-line text-left text-sm text-ink-muted">
              <th scope="col" className="py-2 font-medium">
                Table
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Sittings
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Average time
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Sales
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Average bill
              </th>
            </tr>
          </thead>
          <tbody>
            {report.tables.map((table) => (
              <tr key={table.tableId} className="border-b border-line">
                <th scope="row" className="py-2 text-left font-normal text-ink">
                  {tableHeading(table.label)}
                  {!table.isActive && <span className="text-ink-muted"> · removed</span>}
                </th>
                <td className="py-2 text-right text-ink tabular-nums">{table.sessions}</td>
                <td className="py-2 text-right text-ink tabular-nums">
                  {table.sessions === 0 ? '—' : minutesLabel(table.minutes)}
                </td>
                <td className="py-2 text-right text-ink">
                  <Money paise={table.totalPaise} />
                </td>
                <td className="py-2 text-right text-ink">
                  {table.sessions === 0 ? '—' : <Money paise={table.averagePaise} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="text-lg font-semibold text-ink tabular-nums">{value}</dd>
    </div>
  );
}
