'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { formatINR } from '@/lib/money';

import { compactINR } from '../report';

export type CategoryPoint = { name: string; revenuePaise: number; qty: number };

/** Sales per category (spec §19 Phase 6): one series, longest bar first. */
export function CategoryChart({ points }: { points: CategoryPoint[] }) {
  const best = points[0];
  return (
    <div
      role="img"
      aria-label={
        best
          ? `Sales per category. ${best.name} leads with ${formatINR(best.revenuePaise)}.`
          : 'No category sales in this range.'
      }
      style={{ height: `${Math.max(140, points.length * 44 + 40)}px` }}
      className="w-full min-w-0"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={points}
          layout="vertical"
          margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
          barCategoryGap={8}
        >
          <CartesianGrid horizontal={false} stroke="var(--line)" strokeDasharray="3 3" />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={{ stroke: 'var(--line)' }}
            tick={{ fill: 'var(--ink-muted)', fontSize: 12 }}
            tickFormatter={(value: number) => compactINR(value)}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={120}
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'var(--ink-muted)', fontSize: 12 }}
          />
          <Tooltip
            cursor={{ fill: 'var(--muted)' }}
            content={({ active, payload }) => {
              const point = active
                ? (payload?.[0]?.payload as CategoryPoint | undefined)
                : undefined;
              if (!point) return null;
              return (
                <div className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink shadow-sm">
                  <p className="font-semibold">{point.name}</p>
                  <p className="tabular-nums">{formatINR(point.revenuePaise)}</p>
                  <p className="text-ink-muted">{point.qty} sold</p>
                </div>
              );
            }}
          />
          <Bar dataKey="revenuePaise" fill="var(--chart-1)" radius={[0, 4, 4, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
