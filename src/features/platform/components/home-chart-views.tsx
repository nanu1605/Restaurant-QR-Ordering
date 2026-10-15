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

import { useRouter } from 'next/navigation';

import { compactINR } from '@/features/reports/report';
import { MOVEMENT_LABELS, MOVEMENTS, type Movement } from '@/features/revenue/revenue';
import { formatINR } from '@/lib/money';

/**
 * The super-admin's charts (docs/SUPER_ADMIN_PLAN.md 12e, 13e, 13f), loaded
 * after the page so recharts stays out of the panel's first load. Quiet on
 * purpose: no animation, MenuMesh revenue in --chart-1, GMV in --chart-2, the
 * table under each carries the exact numbers.
 */

export type MrrPoint = { label: string; title: string; mrrPaise: number };
export type UsagePoint = { label: string; gmvPaise: number; orders: number };
export type NewPoint = { label: string; signup: number; team: number };
export type MovementPoint = { label: string; hrefs: Record<Movement, string> } & Record<
  Movement,
  number
>;
export type CollectedPoint = { label: string; subscription: number; setupFee: number };

const axis = {
  tickLine: false,
  tick: { fill: 'var(--ink-muted)', fontSize: 12 },
} as const;
const grid = <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="3 3" />;
// The names stay ink; only the swatch takes the series colour (text contrast).
// Series in the order they are drawn, not by name.
const legend = (
  <Legend
    wrapperStyle={{ fontSize: 12 }}
    itemSorter={null}
    formatter={(value: string) => <span style={{ color: 'var(--ink-muted)' }}>{value}</span>}
  />
);
// Inside role="img" with the table beside it: no keyboard layer of its own.
const quiet = { accessibilityLayer: false, margin: { top: 8, right: 8, bottom: 0, left: 8 } };

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
      <LineChart data={points} {...quiet}>
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
            return point ? <Tip title={point.title} lines={[formatINR(point.mrrPaise)]} /> : null;
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
      <ComposedChart data={points} {...quiet}>
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
                lines={[
                  `GMV ${formatINR(point.gmvPaise)}`,
                  `${point.orders.toLocaleString('en-IN')} ${point.orders === 1 ? 'order' : 'orders'}`,
                ]}
              />
            ) : null;
          }}
        />
        {legend}
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
      <BarChart data={points} {...quiet}>
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
        {legend}
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

// Growth above the line, losses below; never --chart-2, which is GMV's.
const MOVEMENT_COLOURS: Record<Movement, string> = {
  new: 'var(--chart-1)',
  reactivation: 'var(--chart-4)',
  expansion: 'var(--chart-3)',
  contraction: 'var(--status-placed)',
  churn: 'var(--chart-5)',
};

/**
 * MRR movement (plan §5.3) as bars above and below zero. Clicking a bar opens
 * its restaurants; the table's links do the same from the keyboard.
 */
export function MovementChart({ points, summary }: { points: MovementPoint[]; summary: string }) {
  const router = useRouter();
  return (
    <Frame summary={summary}>
      <BarChart data={points} stackOffset="sign" {...quiet}>
        {grid}
        <XAxis
          dataKey="label"
          {...axis}
          axisLine={{ stroke: 'var(--line)' }}
          interval="preserveStartEnd"
          minTickGap={16}
        />
        <YAxis {...axis} axisLine={false} width={64} tickFormatter={(v: number) => compactINR(v)} />
        <Tooltip
          cursor={{ fill: 'var(--muted)' }}
          content={({ active, payload }) => {
            const point = active ? (payload?.[0]?.payload as MovementPoint | undefined) : undefined;
            return point ? (
              <Tip
                title={point.label}
                lines={MOVEMENTS.filter((kind) => point[kind] !== 0).map(
                  (kind) =>
                    `${MOVEMENT_LABELS[kind]} ${formatINR(point[kind], { signDisplay: 'exceptZero' })}`,
                )}
              />
            ) : null;
          }}
        />
        {legend}
        {MOVEMENTS.map((kind) => (
          <Bar
            key={kind}
            dataKey={kind}
            name={MOVEMENT_LABELS[kind]}
            stackId="move"
            fill={MOVEMENT_COLOURS[kind]}
            maxBarSize={32}
            isAnimationActive={false}
            className="cursor-pointer"
            onClick={(_, index) => {
              const href = points[index]?.hrefs[kind];
              if (href) router.push(href);
            }}
          />
        ))}
      </BarChart>
    </Frame>
  );
}

/** Payments collected, before GST: subscriptions and setup fees stacked. */
export function CollectedChart({ points, summary }: { points: CollectedPoint[]; summary: string }) {
  return (
    <Frame summary={summary}>
      <BarChart data={points} {...quiet}>
        {grid}
        <XAxis
          dataKey="label"
          {...axis}
          axisLine={{ stroke: 'var(--line)' }}
          interval="preserveStartEnd"
          minTickGap={16}
        />
        <YAxis {...axis} axisLine={false} width={64} tickFormatter={(v: number) => compactINR(v)} />
        <Tooltip
          cursor={{ fill: 'var(--muted)' }}
          content={({ active, payload }) => {
            const point = active
              ? (payload?.[0]?.payload as CollectedPoint | undefined)
              : undefined;
            return point ? (
              <Tip
                title={point.label}
                lines={[
                  `Subscriptions ${formatINR(point.subscription)}`,
                  `Setup fees ${formatINR(point.setupFee)}`,
                ]}
              />
            ) : null;
          }}
        />
        {legend}
        <Bar
          dataKey="subscription"
          name="Subscriptions"
          stackId="paid"
          fill="var(--chart-1)"
          maxBarSize={32}
          isAnimationActive={false}
        />
        <Bar
          dataKey="setupFee"
          name="Setup fees"
          stackId="paid"
          fill="var(--chart-3)"
          radius={[3, 3, 0, 0]}
          maxBarSize={32}
          isAnimationActive={false}
        />
      </BarChart>
    </Frame>
  );
}
