'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { compactINR } from '@/features/reports/report';
import { formatINR } from '@/lib/money';

/**
 * Home's charts (docs/SUPER_ADMIN_PLAN.md 12e), loaded after the page so
 * recharts stays out of the panel's first load. Quiet on purpose: no
 * animation, MenuMesh revenue in --chart-1, GMV in --chart-2, the table
 * under each carries the exact numbers.
 */

export type MrrPoint = { label: string; mrrPaise: number };
export type UsagePoint = { label: string; gmvPaise: number; orders: number };
export type NewPoint = { label: string; signup: number; team: number };

const axis = {
  tickLine: false,
  tick: { fill: 'var(--ink-muted)', fontSize: 12 },
} as const;
const grid = <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="3 3" />;

function Frame({ summary, children }: { summary: string; children: React.ReactElement }) {
  return (
    <div role="img" aria-label={summary} className="h-56 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

function Tip({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink shadow-sm">
      <p className="font-semibold">{title}</p>
      {lines.map((line) => (
        <p key={line} className="tabular-nums">
          {line}
        </p>
      ))}
    </div>
  );
}

export function MrrChart({ points, summary }: { points: MrrPoint[]; summary: string }) {
  return (
    <Frame summary={summary}>
      <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        {grid}
        <XAxis
          dataKey="label"
          {...axis}
          axisLine={{ stroke: 'var(--line)' }}
          interval="preserveStartEnd"
          minTickGap={24}
        />
        <YAxis {...axis} axisLine={false} width={64} tickFormatter={(v: number) => compactINR(v)} />
        <Tooltip
          content={({ active, payload }) => {
            const point = active ? (payload?.[0]?.payload as MrrPoint | undefined) : undefined;
            return point ? <Tip title={point.label} lines={[formatINR(point.mrrPaise)]} /> : null;
          }}
        />
        <Line
          type="monotone"
          dataKey="mrrPaise"
          name="MRR"
          stroke="var(--chart-1)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </Frame>
  );
}

export function UsageChart({ points, summary }: { points: UsagePoint[]; summary: string }) {
  return (
    <Frame summary={summary}>
      <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        {grid}
        <XAxis
          dataKey="label"
          {...axis}
          axisLine={{ stroke: 'var(--line)' }}
          interval="preserveStartEnd"
          minTickGap={16}
        />
        <YAxis
          yAxisId="gmv"
          {...axis}
          axisLine={false}
          width={64}
          tickFormatter={(v: number) => compactINR(v)}
        />
        <YAxis yAxisId="orders" orientation="right" {...axis} axisLine={false} width={40} />
        <Tooltip
          cursor={{ fill: 'var(--muted)' }}
          content={({ active, payload }) => {
            const point = active ? (payload?.[0]?.payload as UsagePoint | undefined) : undefined;
            return point ? (
              <Tip
                title={point.label}
                lines={[`GMV ${formatINR(point.gmvPaise)}`, `${point.orders} orders`]}
              />
            ) : null;
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: 'var(--ink-muted)' }} />
        <Bar
          yAxisId="gmv"
          dataKey="gmvPaise"
          name="GMV"
          fill="var(--chart-2)"
          radius={[3, 3, 0, 0]}
          maxBarSize={24}
          isAnimationActive={false}
        />
        <Line
          yAxisId="orders"
          type="monotone"
          dataKey="orders"
          name="Orders"
          stroke="var(--chart-4)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </Frame>
  );
}

export function NewRestaurantsChart({ points, summary }: { points: NewPoint[]; summary: string }) {
  return (
    <Frame summary={summary}>
      <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        {grid}
        <XAxis
          dataKey="label"
          {...axis}
          axisLine={{ stroke: 'var(--line)' }}
          interval="preserveStartEnd"
          minTickGap={16}
        />
        <YAxis {...axis} axisLine={false} width={32} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: 'var(--muted)' }}
          content={({ active, payload }) => {
            const point = active ? (payload?.[0]?.payload as NewPoint | undefined) : undefined;
            return point ? (
              <Tip
                title={`Week of ${point.label}`}
                lines={[`${point.signup} signed up`, `${point.team} onboarded by the team`]}
              />
            ) : null;
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: 'var(--ink-muted)' }} />
        <Bar
          dataKey="signup"
          name="Signed up"
          stackId="new"
          fill="var(--chart-3)"
          maxBarSize={32}
          isAnimationActive={false}
        />
        <Bar
          dataKey="team"
          name="Onboarded by the team"
          stackId="new"
          fill="var(--chart-4)"
          radius={[3, 3, 0, 0]}
          maxBarSize={32}
          isAnimationActive={false}
        />
      </BarChart>
    </Frame>
  );
}
