/**
 * A tiny line of daily counts, oldest first, drawn on the server (plan §1:
 * charts stay quiet). The label says the numbers for screen readers.
 */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const width = 64;
  const height = 20;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((value, index) => `${index * step},${height - 2 - (value / max) * (height - 4)}`)
    .join(' ');
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="shrink-0 overflow-visible text-chart-2"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
