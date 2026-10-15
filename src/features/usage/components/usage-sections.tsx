import { ArrowDown, ArrowUp, Check, Minus } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Money } from '@/components/shared/money';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatShare } from '@/features/growth/funnel';
import { Figure } from '@/features/platform/components/home-sections';
import { Section } from '@/features/platform/components/restaurant-sections';
import { qrShare } from '@/features/platform/restaurant-page';
import { minutesLabel } from '@/features/reports/report';
import { hrefWithParams } from '@/lib/date-range';

import {
  changeNote,
  percent,
  USAGE_FEATURE_RULES,
  USAGE_FEATURES,
  type UsageFeature,
  type UsageGroup,
  type UsageReport,
} from '../usage';

const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';
const n = (value: number) => value.toLocaleString('en-IN');
// Key numbers in whole rupees, as on Home.
const rupees = (paise: number) => Math.round(paise / 100) * 100;

/** A percentage with a quiet bar under it; the bar is decoration. */
function ShareCell({ part, whole }: { part: number; whole: number }) {
  return (
    <div className="flex min-w-24 flex-col gap-1">
      <span className="tabular-nums">{percent(part, whole)}</span>
      <div aria-hidden className="h-1.5 rounded-full bg-line">
        <div
          className="h-1.5 rounded-full bg-chart-2"
          style={{ width: `${whole === 0 ? 0 : (part / whole) * 100}%` }}
        />
      </div>
    </div>
  );
}

function Change({ now, before, period }: { now: number; before: number; period: string }) {
  const change = changeNote(now, before, period);
  return (
    <span className="inline-flex items-center gap-0.5">
      {change.direction === 'up' && <ArrowUp aria-hidden className="size-3" />}
      {change.direction === 'down' && <ArrowDown aria-hidden className="size-3" />}
      {change.text}
    </span>
  );
}

/** The key numbers (plan 13e), each against the period before when comparing. */
export function UsageKeyNumbers({ report, period }: { report: UsageReport; period: string }) {
  const { totals, previous } = report;
  const average = totals.bills > 0 ? Math.round(totals.gmv_paise / totals.bills) : null;
  const previousAverage =
    previous && previous.bills > 0 ? Math.round(previous.gmv_paise / previous.bills) : null;
  const qr = qrShare(totals.customer_orders, totals.staff_orders);
  const previousQr = previous && qrShare(previous.customer_orders, previous.staff_orders);
  const change = (now: number, before: number | undefined) =>
    before === undefined ? null : <Change now={now} before={before} period={period} />;

  return (
    <section aria-labelledby="usage-numbers" className="flex flex-col gap-2">
      <h2 id="usage-numbers" className="text-lg font-semibold text-ink">
        Key numbers
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg border border-line bg-surface p-4 sm:grid-cols-4">
        <Figure
          label="GMV"
          note={change(totals.gmv_paise, previous?.gmv_paise) ?? 'Diners’ bills, taxes included'}
        >
          <Money paise={rupees(totals.gmv_paise)} fraction="auto" />
        </Figure>
        <Figure label="Orders" note={change(totals.orders, previous?.orders) ?? 'Accepted orders'}>
          {n(totals.orders)}
        </Figure>
        <Figure label="Bills" note={change(totals.bills, previous?.bills)}>
          {n(totals.bills)}
        </Figure>
        <Figure
          label="Average bill"
          note={
            average !== null && previousAverage !== null
              ? change(average, previousAverage)
              : undefined
          }
        >
          {average === null ? '—' : <Money paise={average} fraction="auto" />}
        </Figure>
        <Figure label="Items" note={change(totals.items, previous?.items) ?? 'In billed orders'}>
          {n(totals.items)}
        </Figure>
        <Figure
          label="Active restaurants"
          note={
            <>
              Of {n(totals.restaurants)} restaurants
              {previous && (
                <>
                  <br />
                  <Change now={totals.active} before={previous.active} period={period} />
                </>
              )}
            </>
          }
        >
          {n(totals.active)}
        </Figure>
        <Figure
          label="QR orders"
          note={
            qr && (
              <>
                {qr.note}
                {previous && (
                  <>
                    <br />
                    {previousQr ? `${previousQr.value} in ${period}` : `None in ${period}`}
                  </>
                )}
              </>
            )
          }
        >
          {qr ? qr.value : '—'}
        </Figure>
      </dl>
    </section>
  );
}

/** Places and plans, ranked, each linking to its restaurants. */
export function GroupTable<T extends UsageGroup>({
  title,
  what,
  groups,
  total,
  href,
  unknown,
}: {
  title: string;
  /** The first column's heading. */
  what: string;
  groups: T[];
  /** All GMV, for the shares. */
  total: number;
  href: (group: T) => string | null;
  unknown: string;
}) {
  return (
    <Section title={title}>
      {groups.length === 0 ? (
        <p className="text-sm text-ink-muted">No restaurants yet.</p>
      ) : (
        <Table label={title} regionClassName="max-h-96 overflow-y-auto">
          <TableHeader>
            <TableRow>
              <TableHead>{what}</TableHead>
              <TableHead className="text-right">Restaurants</TableHead>
              <TableHead className="text-right">Orders</TableHead>
              <TableHead className="text-right">GMV</TableHead>
              <TableHead>Share of GMV</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => {
              const link = href(group);
              return (
                <TableRow key={group.name ?? ''}>
                  <TableCell className="max-w-48 whitespace-normal">
                    {link ? (
                      <Link href={link} className={linkClass}>
                        {group.name}
                      </Link>
                    ) : (
                      (group.name ?? unknown)
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {n(group.restaurants)}
                    <div className="text-xs text-ink-muted">{n(group.active)} active</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{n(group.orders)}</TableCell>
                  <TableCell className="text-right">
                    <Money paise={group.gmv_paise} fraction="auto" />
                  </TableCell>
                  <TableCell>
                    <ShareCell part={group.gmv_paise} whole={total} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

/** Ten restaurants by GMV or orders, with their share of the total. */
export function RankedTable({
  title,
  rows,
  measure,
  total,
}: {
  title: string;
  rows: UsageReport['top_gmv'];
  measure: 'gmv' | 'orders';
  total: number;
}) {
  return (
    <Section title={title}>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">No orders in these dates.</p>
      ) : (
        <Table label={title}>
          <TableHeader>
            <TableRow>
              <TableHead>Restaurant</TableHead>
              <TableHead className="text-right">{measure === 'gmv' ? 'GMV' : 'Orders'}</TableHead>
              <TableHead>Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const value = measure === 'gmv' ? row.gmv_paise : row.orders;
              return (
                <TableRow key={row.id}>
                  <TableCell className="max-w-56 whitespace-normal">
                    <Link href={`/super/restaurants/${row.id}`} className={linkClass}>
                      {row.name}
                    </Link>
                    {row.city && <div className="text-xs text-ink-muted">{row.city}</div>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {measure === 'gmv' ? <Money paise={value} fraction="auto" /> : n(value)}
                  </TableCell>
                  <TableCell>
                    <ShareCell part={value} whole={total} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

const MODES = [
  ['cash', 'Cash'],
  ['upi', 'UPI'],
  ['card', 'Card'],
  ['other', 'Other'],
] as const;

/** How diners paid, table time and the rest of the bills' story. */
export function BillsSection({ report }: { report: UsageReport }) {
  const { totals } = report;
  const collected = MODES.reduce((sum, [mode]) => sum + totals.collected[mode], 0);
  const facts: [string, ReactNode][] = [
    [
      'Average table time',
      totals.table_minutes === null ? '—' : minutesLabel(totals.table_minutes),
    ],
    ['Discounts given', <Money key="discount" paise={totals.discount_paise} fraction="auto" />],
    ['Calls for a waiter or the bill', n(totals.service_requests)],
  ];
  return (
    <Section title="Bills and payments">
      <p className="text-sm text-ink-muted">
        Payments recorded on the bills of these dates. Table time runs from a table’s first order to
        its bill.
      </p>
      {collected === 0 ? (
        <p className="text-sm text-ink-muted">No payments recorded on these bills.</p>
      ) : (
        <Table label="Payments by mode">
          <TableHeader>
            <TableRow>
              <TableHead>Paid by</TableHead>
              <TableHead className="text-right">Collected</TableHead>
              <TableHead>Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {MODES.map(([mode, label]) => (
              <TableRow key={mode}>
                <TableCell>{label}</TableCell>
                <TableCell className="text-right">
                  <Money paise={totals.collected[mode]} fraction="auto" />
                </TableCell>
                <TableCell>
                  <ShareCell part={totals.collected[mode]} whole={collected} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {facts.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-ink-muted">{term}</dt>
            <dd className="text-ink tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

/** Feature adoption among active Paid restaurants (docs/DECISIONS.md SA-63). */
export function FeatureAdoption({ features }: { features: UsageReport['features'] }) {
  return (
    <Section title="Features in use">
      <p className="text-sm text-ink-muted">
        Of the {n(features.restaurants)} Paid restaurants with an order in these dates: paid now.
      </p>
      <Table label="Features in use">
        <TableHeader>
          <TableRow>
            <TableHead>Feature</TableHead>
            <TableHead>Restaurants using it</TableHead>
            <TableHead>Counted when</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {USAGE_FEATURES.map((key) => (
            <TableRow key={key}>
              <TableCell>{USAGE_FEATURE_RULES[key].label}</TableCell>
              <TableCell className="tabular-nums">
                {formatShare(features.used[key] ?? 0, features.restaurants)}
              </TableCell>
              <TableCell className="max-w-80 text-sm whitespace-normal text-ink-muted">
                {USAGE_FEATURE_RULES[key].rule}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

/** One restaurant's features, used or not (its Usage tab). */
export function FeaturesUsed({ used }: { used: Record<UsageFeature, boolean> }) {
  return (
    <ul className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {USAGE_FEATURES.map((key) => (
        <li key={key} className="flex items-start gap-2">
          {used[key] ? (
            <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-status-ready" />
          ) : (
            <Minus aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          )}
          <span className="flex flex-col">
            <span className="text-ink">
              {USAGE_FEATURE_RULES[key].label}: {used[key] ? 'used' : 'not used'}
            </span>
            <span className="text-xs text-ink-muted">{USAGE_FEATURE_RULES[key].rule}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A link to the Restaurants list filtered to a city, state or plan. */
export function restaurantsHref(filter: 'city' | 'region' | 'plan', value: string | null) {
  return value ? hrefWithParams('/super/restaurants', { [filter]: value }) : null;
}
