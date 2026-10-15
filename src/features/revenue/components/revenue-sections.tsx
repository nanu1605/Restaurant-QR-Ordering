import Link from 'next/link';
import type { ReactNode } from 'react';

import { Money } from '@/components/shared/money';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatShare } from '@/features/growth/funnel';
import { Figure } from '@/features/platform/components/home-sections';
import { Section } from '@/features/platform/components/restaurant-sections';
import {
  formatDate,
  SUBSCRIPTION_STATE_LABELS,
  type SubscriptionState,
} from '@/features/platform/platform';
import { CANCEL_REASON_LABELS, type CancelReason } from '@/features/subscriptions/cancel-reasons';
import { Change, ShareCell } from '@/features/usage/components/usage-sections';
import { percent } from '@/features/usage/usage';
import { hrefWithParams } from '@/lib/date-range';

import { netNewPaise, type MovementList, type RevenueReport } from '../revenue';

const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';
const n = (value: number) => value.toLocaleString('en-IN');
// Key numbers in whole rupees, as on Home.
const rupees = (paise: number) => Math.round(paise / 100) * 100;
const noon = (day: string) => `${day}T12:00:00+05:30`;
const stateLabel = (state: string | null) =>
  state ? (SUBSCRIPTION_STATE_LABELS[state as SubscriptionState] ?? state) : 'Not yet created';

/** Of the trials decided (paid, or 30 days past the trial), how many paid. */
const conversionShare = (c: RevenueReport['totals']['conversion']) =>
  formatShare(c.converted, c.created - c.deciding);

/** Of the failed charges decided (paid again, or not), how many paid again. */
const recoveryShare = (r: RevenueReport['totals']['recovery']) =>
  formatShare(r.recovered, r.entered - r.still_failed);

/**
 * The key numbers (plan 13f): MRR and its parts at the end of the dates, what
 * moved and was collected in them, each against the period before when
 * comparing. MRR figures wait for history; today's lists are linked only when
 * the dates end today.
 */
export function RevenueKeyNumbers({
  report,
  period,
  historyNote,
  live,
  churnHref,
}: {
  report: RevenueReport;
  period: string;
  historyNote: string;
  /** Whether the dates end today, so today's lists are the rows behind the figures. */
  live: boolean;
  /** The churned restaurants in these dates. */
  churnHref: string;
}) {
  const { totals, previous, expected } = report;
  const mrr = totals.mrr_paise;
  const paid = totals.paid;
  const arpu = mrr !== null && paid ? Math.round(mrr / paid) : null;
  const opened = totals.opening_day !== null;
  const net = netNewPaise(totals.movements);
  const paidList = live ? '/super/money/subscriptions?state=paid' : undefined;
  const collected =
    totals.collected.subscription_base_paise + totals.collected.setup_fee_base_paise;
  const change = (now: number | null, before: number | null | undefined) =>
    now === null || before === null || before === undefined ? null : (
      <Change now={now} before={before} period={period} />
    );
  const since = opened ? `Since ${formatDate(noon(totals.opening_day!))}` : historyNote;

  return (
    <section aria-labelledby="revenue-numbers" className="flex flex-col gap-2">
      <h2 id="revenue-numbers" className="text-lg font-semibold text-ink">
        Key numbers
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg border border-line bg-surface p-4 sm:grid-cols-4">
        <Figure
          label="MRR"
          href={paidList}
          note={change(mrr, previous?.mrr_paise) ?? 'Before GST, at the end of the dates'}
        >
          {mrr === null ? '—' : <Money paise={rupees(mrr)} fraction="auto" />}
        </Figure>
        <Figure label="ARR" note="MRR × 12">
          {mrr === null ? '—' : <Money paise={rupees(mrr * 12)} fraction="auto" />}
        </Figure>
        <Figure
          label="Net new MRR"
          href="#chart-revenue-movement"
          note={
            opened ? (
              previous?.opening_day ? (
                <>
                  <Money
                    paise={netNewPaise(previous.movements)}
                    fraction="auto"
                    signDisplay="exceptZero"
                  />{' '}
                  in {period}
                </>
              ) : (
                since
              )
            ) : (
              historyNote
            )
          }
        >
          {opened ? <Money paise={rupees(net)} fraction="auto" signDisplay="exceptZero" /> : '—'}
        </Figure>
        <Figure label="Paid restaurants" href={paidList} note={change(paid, previous?.paid)}>
          {paid === null ? '—' : n(paid)}
        </Figure>
        <Figure label="ARPU" note="MRR per Paid restaurant">
          {arpu === null ? '—' : <Money paise={arpu} fraction="auto" />}
        </Figure>
        <Figure
          label="Collected"
          href={hrefWithParams('/super/money/payments', { from: report.from, to: report.to })}
          note={
            change(
              collected,
              previous &&
                previous.collected.subscription_base_paise +
                  previous.collected.setup_fee_base_paise,
            ) ?? (
              <>
                + GST <Money paise={totals.collected.gst_paise} fraction="auto" />
              </>
            )
          }
        >
          <Money paise={rupees(collected)} fraction="auto" />
        </Figure>
        <Figure
          label="Trial conversion"
          href="#section-trial-cohorts"
          note={
            <>
              Restaurants created in these dates
              {totals.conversion.deciding > 0 && <>, {n(totals.conversion.deciding)} deciding</>}
              {previous && (
                <>
                  <br />
                  {conversionShare(previous.conversion)} in {period}
                </>
              )}
            </>
          }
        >
          {conversionShare(totals.conversion)}
        </Figure>
        <Figure
          label="Restaurant churn"
          href={churnHref}
          note={
            opened ? (
              <>
                Of {n(totals.opening_paid ?? 0)} Paid at the start
                {previous?.opening_day && (
                  <>
                    <br />
                    {formatShare(previous.churned, previous.opening_paid ?? 0)} in {period}
                  </>
                )}
              </>
            ) : (
              historyNote
            )
          }
        >
          {opened ? formatShare(totals.churned, totals.opening_paid ?? 0) : '—'}
        </Figure>
        <Figure
          label="Revenue churn"
          href={churnHref}
          note={
            opened ? (
              <>
                <Money paise={totals.lost_paise} fraction="auto" /> of the start’s MRR lost or cut
                {previous?.opening_day && (
                  <>
                    <br />
                    {percent(previous.lost_paise, previous.opening_mrr_paise ?? 0)} in {period}
                  </>
                )}
              </>
            ) : (
              historyNote
            )
          }
        >
          {opened ? percent(totals.lost_paise, totals.opening_mrr_paise ?? 0) : '—'}
        </Figure>
        <Figure
          label="Failed-payment recovery"
          href={churnHref}
          note={
            totals.recovery.still_failed > 0
              ? `Paid again, of those decided; ${n(totals.recovery.still_failed)} still in Payment failed`
              : 'Paid again before going read-only'
          }
        >
          {opened ? recoveryShare(totals.recovery) : '—'}
        </Figure>
        <Figure
          label="Expected in 30 days, incl. GST"
          href="/super/money/dues?bucket=renewal_due"
          note={
            <>
              <Money paise={expected.autopay_paise} fraction="auto" /> on autopay,{' '}
              <Money paise={expected.needs_payment_paise} fraction="auto" /> needing a payment
            </>
          }
        >
          <Money
            paise={rupees(expected.autopay_paise + expected.needs_payment_paise)}
            fraction="auto"
          />
        </Figure>
      </dl>
    </section>
  );
}

/** The restaurants behind one movement, with MRR before and after. */
export function MovementTable({ list, label }: { list: MovementList; label: string }) {
  if (list.rows.length === 0) {
    return <p className="text-sm text-ink-muted">No restaurants moved this way in these dates.</p>;
  }
  return (
    <>
      {list.total > list.rows.length && (
        <p className="text-sm text-ink-muted">
          The latest {n(list.rows.length)} of {n(list.total)}.
        </p>
      )}
      <Table label={label} regionClassName="max-h-[32rem] overflow-y-auto">
        <TableHeader>
          <TableRow>
            <TableHead>Restaurant</TableHead>
            <TableHead>Day</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="text-right">MRR before</TableHead>
            <TableHead className="text-right">MRR after</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.rows.map((row) => (
            <TableRow key={`${row.restaurant_id}-${row.day}`}>
              <TableCell className="max-w-56 whitespace-normal">
                <Link
                  href={`/super/restaurants/${row.restaurant_id}/billing`}
                  className={linkClass}
                >
                  {row.name}
                </Link>
                {row.city && <div className="text-xs text-ink-muted">{row.city}</div>}
              </TableCell>
              <TableCell>{formatDate(noon(row.day))}</TableCell>
              <TableCell>
                {row.plan_before && row.plan_before !== row.plan_after
                  ? `${row.plan_before} to ${row.plan_after ?? '—'}`
                  : (row.plan_after ?? '—')}
              </TableCell>
              <TableCell>
                {row.state_before === row.state_after
                  ? stateLabel(row.state_after)
                  : `${stateLabel(row.state_before)} to ${stateLabel(row.state_after)}`}
              </TableCell>
              <TableCell className="text-right">
                <Money paise={row.before_paise} fraction="auto" />
              </TableCell>
              <TableCell className="text-right">
                <Money paise={row.after_paise} fraction="auto" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

/** Paid restaurants by plan, monthly against yearly, at the end of the dates. */
export function PlanMix({
  report,
  live,
  historyNote,
}: {
  report: RevenueReport;
  live: boolean;
  historyNote: string;
}) {
  const plans = [...new Set(report.plan_mix.map((row) => row.plan_code))].map((code) => {
    const rows = report.plan_mix.filter((row) => row.plan_code === code);
    const count = (cycle: 'monthly' | 'yearly') =>
      rows.find((row) => row.billing_cycle === cycle)?.restaurants ?? 0;
    return {
      code,
      name: rows[0]!.plan_name,
      monthly: count('monthly'),
      yearly: count('yearly'),
      mrr: rows.reduce((sum, row) => sum + row.mrr_paise, 0),
    };
  });
  const total = plans.reduce((sum, plan) => sum + plan.mrr, 0);
  const all = (cycle: 'monthly' | 'yearly') => plans.reduce((sum, plan) => sum + plan[cycle], 0);
  return (
    <Section title="Plan mix">
      <p className="text-sm text-ink-muted">Paid restaurants at the end of the dates.</p>
      {report.totals.mrr_paise === null ? (
        <p className="text-sm text-ink-muted">{historyNote}</p>
      ) : plans.length === 0 ? (
        <p className="text-sm text-ink-muted">No Paid restaurants.</p>
      ) : (
        <Table label="Plan mix">
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead>
              <TableHead className="text-right">Monthly</TableHead>
              <TableHead className="text-right">Yearly</TableHead>
              <TableHead className="text-right">MRR</TableHead>
              <TableHead>Share of MRR</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.map((plan) => (
              <TableRow key={plan.code}>
                <TableCell>
                  {live ? (
                    <Link
                      href={hrefWithParams('/super/restaurants', {
                        state: 'paid',
                        plan: plan.code,
                      })}
                      className={linkClass}
                    >
                      {plan.name}
                    </Link>
                  ) : (
                    plan.name
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{n(plan.monthly)}</TableCell>
                <TableCell className="text-right tabular-nums">{n(plan.yearly)}</TableCell>
                <TableCell className="text-right">
                  <Money paise={plan.mrr} fraction="auto" />
                </TableCell>
                <TableCell>
                  <ShareCell part={plan.mrr} whole={total} bar="bg-chart-1" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>All plans</TableCell>
              <TableCell className="text-right tabular-nums">
                {n(all('monthly'))}
                <div className="text-xs text-ink-muted">
                  {formatShare(all('monthly'), all('monthly') + all('yearly'))}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {n(all('yearly'))}
                <div className="text-xs text-ink-muted">
                  {formatShare(all('yearly'), all('monthly') + all('yearly'))}
                </div>
              </TableCell>
              <TableCell className="text-right">
                <Money paise={total} fraction="auto" />
              </TableCell>
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      )}
    </Section>
  );
}

const monthLabel = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  month: 'long',
  year: 'numeric',
});

/** Trial cohorts by the month restaurants were created (plan §5.7). */
export function TrialCohorts({ cohorts }: { cohorts: RevenueReport['cohorts'] }) {
  return (
    <Section title="Trial cohorts">
      <p className="text-sm text-ink-muted">
        By the month each restaurant was created. Converted: its first subscription payment came by
        the end of its trial plus 30 days. Deciding: neither paid nor past that yet.
      </p>
      {cohorts.length === 0 ? (
        <p className="text-sm text-ink-muted">No restaurants created in these dates.</p>
      ) : (
        <Table label="Trial cohorts">
          <TableHeader>
            <TableRow>
              <TableHead>Created in</TableHead>
              <TableHead className="text-right">Restaurants</TableHead>
              <TableHead className="text-right">Deciding</TableHead>
              <TableHead>Converted</TableHead>
              <TableHead className="text-right">Average days to pay</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cohorts.map((cohort) => (
              <TableRow key={cohort.start}>
                <TableCell>
                  {cohort.start.endsWith('-01')
                    ? monthLabel.format(new Date(noon(cohort.start)))
                    : `From ${formatDate(noon(cohort.start))}`}
                </TableCell>
                <TableCell className="text-right tabular-nums">{n(cohort.created)}</TableCell>
                <TableCell className="text-right tabular-nums">{n(cohort.deciding)}</TableCell>
                <TableCell className="tabular-nums">
                  {formatShare(cohort.converted, cohort.created - cohort.deciding)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {cohort.average_days ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

/** Why restaurants turned autopay off themselves (docs/DECISIONS.md SA-15). */
export function CancelReasons({ report }: { report: RevenueReport }) {
  const total = report.reasons.reduce((sum, row) => sum + row.count, 0);
  return (
    <Section
      title="Cancellation reasons"
      action={
        total > 0 && (
          <Link
            href={hrefWithParams('/super/audit', {
              action: 'subscription.cancel_reason',
              from: report.from,
              to: report.to,
            })}
            className={`text-sm ${linkClass}`}
          >
            See each answer
          </Link>
        )
      }
    >
      <p className="text-sm text-ink-muted">
        Asked when a restaurant turns autopay off itself; the team’s cancellations don’t ask.
      </p>
      {total === 0 ? (
        <p className="text-sm text-ink-muted">No reasons given in these dates.</p>
      ) : (
        <Table label="Cancellation reasons">
          <TableHeader>
            <TableRow>
              <TableHead>Reason</TableHead>
              <TableHead className="text-right">Times given</TableHead>
              <TableHead>Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.reasons.map((row) => (
              <TableRow key={row.reason ?? ''}>
                <TableCell>
                  {CANCEL_REASON_LABELS[row.reason as CancelReason] ?? 'Not given'}
                </TableCell>
                <TableCell className="text-right tabular-nums">{n(row.count)}</TableCell>
                <TableCell>
                  <ShareCell
                    part={row.count}
                    whole={total}
                    bar="bg-chart-1"
                    label={formatShare(row.count, total)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

/** Setup fees paid in the dates, and how many had the launch offer. */
export function LaunchOffer({ report }: { report: RevenueReport }) {
  const offer = report.launch_offer;
  const facts: [string, ReactNode][] = [
    [
      'With the launch offer',
      <>
        {n(offer.with_offer)}, <Money paise={offer.discount_paise} fraction="auto" /> off in total
      </>,
    ],
    ['At the full fee', n(offer.full_price)],
    ['Fee not recorded', n(offer.not_recorded)],
  ];
  return (
    <Section
      title="Launch offer"
      action={
        <Link
          href={hrefWithParams('/super/money/payments', {
            from: report.from,
            to: report.to,
            purpose: 'setup_fee',
          })}
          className={`text-sm ${linkClass}`}
        >
          {n(offer.setup_fees)} setup {offer.setup_fees === 1 ? 'fee' : 'fees'} paid
        </Link>
      }
    >
      <p className="text-sm text-ink-muted">
        Setup fees paid in these dates. Payments recorded before the fee and its discount were kept
        with them (12b) show as not recorded.
      </p>
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
