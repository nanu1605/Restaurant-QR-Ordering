import { ScrollRegion } from '@/components/shared/scroll-region';
import { hourLabel, hourOrder, WEEKDAYS, WEEKDAYS_SHORT } from '@/features/reports/report';

/** Cell fill: the quietest hour at 30% of the chart hue, the busiest at full strength. */
function cellColor(share: number): string {
  return `color-mix(in oklab, var(--chart-1) ${Math.round(30 + share * 70)}%, var(--surface))`;
}

export type HeatmapCell = { weekday: number; hour: number; value: number };

/**
 * A weekday and hour grid in the sales heatmap's style, for the super-admin
 * pages (docs/SUPER_ADMIN_PLAN.md §1, 13a, 13e): ISO weekdays, the hours of a
 * business day from its start hour, and the numbers for screen readers.
 */
export function Heatmap({
  label,
  cells,
  startHour,
  describe,
}: {
  /** What the grid shows, for its caption and scroll region. */
  label: string;
  cells: HeatmapCell[];
  startHour: number;
  /** "3 orders", for one cell. */
  describe: (value: number) => string;
}) {
  const busiest = Math.max(0, ...cells.map((cell) => cell.value));
  const byKey = new Map(cells.map((cell) => [`${cell.weekday}-${cell.hour}`, cell.value]));
  const columns = hourOrder(startHour);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ScrollRegion label={label}>
        <table className="border-collapse text-sm">
          <caption className="sr-only">{label}; darker cells are busier</caption>
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
            {WEEKDAYS.map((name, index) => (
              <tr key={name}>
                <th scope="row" className="p-1 text-left font-medium text-ink-muted">
                  <span aria-hidden>{WEEKDAYS_SHORT[index]}</span>
                  <span className="sr-only">{name}</span>
                </th>
                {columns.map((hour) => {
                  const value = byKey.get(`${index + 1}-${hour}`) ?? 0;
                  return (
                    <td key={hour} className="p-0.5">
                      <span
                        title={value ? `${name} ${hourLabel(hour)}: ${describe(value)}` : undefined}
                        className="block size-6 rounded-sm border border-line"
                        style={{
                          backgroundColor:
                            value && busiest ? cellColor(value / busiest) : 'var(--surface)',
                        }}
                      >
                        {value > 0 && <span className="sr-only">{describe(value)}</span>}
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
        {busiest > 0 && (
          <span className="tabular-nums">(up to {describe(busiest)} in an hour)</span>
        )}
      </div>
    </div>
  );
}
