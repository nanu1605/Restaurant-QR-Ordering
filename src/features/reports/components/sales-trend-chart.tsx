'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { formatINR } from '@/lib/money';

import { compactINR } from '../report';

export type TrendPoint = { label: string; title: string; totalPaise: number; bills: number };

type SalesTrendChartProps = {
  points: TrendPoint[];
  /** Screen-reader summary; the table underneath carries the numbers. */
  summary: string;
};

/**
 * Sales per business day (spec §19 Phase 6). One series, one hue: the bars
 * carry magnitude and the table below carries the exact numbers.
 */
export function SalesTrendChart({ points, summary }: SalesTrendChartProps) {
  return (
    <div role="img" aria-label={summary} className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: 'var(--line)' }}
            tick={{ fill: 'var(--ink-muted)', fontSize: 12 }}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={64}
            tick={{ fill: 'var(--ink-muted)', fontSize: 12 }}
            tickFormatter={(value: number) => compactINR(value)}
          />
          <Tooltip
            cursor={{ fill: 'var(--muted)' }}
            content={({ active, payload }) => {
              const point = active ? (payload?.[0]?.payload as TrendPoint | undefined) : undefined;
              if (!point) return null;
              return (
                <div className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink shadow-sm">
                  <p className="font-semibold">{point.title}</p>
                  <p className="tabular-nums">{formatINR(point.totalPaise)}</p>
                  <p className="text-ink-muted">
                    {point.bills} {point.bills === 1 ? 'bill' : 'bills'}
                  </p>
                </div>
              );
            }}
          />
          <Bar dataKey="totalPaise" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={48} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
