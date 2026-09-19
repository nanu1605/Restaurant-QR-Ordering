import { cn } from 'cn';
import { Check, Minus } from 'lucide-react';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Money } from '@/components/shared/money';
import { PageHeader } from '@/components/shared/page-header';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { FEATURE_KEYS, FEATURE_LABELS } from '@/features/plans/plan-features';
import { getPlanFeatures } from '@/features/plans/queries';
import {
  getOwnerSubscription,
  getPlanUsage,
  getSubscriptionPayments,
} from '@/features/subscriptions/queries';
import {
  formatDay,
  formatPaidPeriod,
  lastDay,
  PAYMENT_METHOD_LABELS,
  subscriptionSummary,
  type OwnerSubscription,
  type SubscriptionSummary,
} from '@/features/subscriptions/summary';
import { getRestaurantAccess } from '@/lib/auth/access';
import { requireMember } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Subscription',
};

const TONE_CLASSES: Record<SubscriptionSummary['tone'], string> = {
  ok: 'bg-status-served-fill text-status-served-foreground',
  warning: 'bg-status-preparing-fill text-status-preparing-foreground',
  blocked: 'bg-status-void text-white',
};

export default async function SubscriptionPage() {
  // Owner only (spec §13.3).
  const membership = await requireMember(['owner']);
  const restaurantId = membership.restaurant.id;
  const timezone = membership.restaurant.timezone;
  const [subscription, payments, plan, usage, access] = await Promise.all([
    getOwnerSubscription(restaurantId),
    getSubscriptionPayments(restaurantId),
    getPlanFeatures(restaurantId),
    getPlanUsage(restaurantId),
    getRestaurantAccess(restaurantId),
  ]);
  const summary = subscriptionSummary({ subscription, access, timezone });

  return (
    <>
      <PageHeader title="Subscription" />

      <Section title="Your plan">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-2xl font-semibold text-ink">
            {subscription?.plan.name ?? 'No plan'}
          </span>
          <span
            data-testid="subscription-status"
            className={cn(
              'rounded-full px-2.5 py-0.5 text-sm font-medium',
              TONE_CLASSES[summary.tone],
            )}
          >
            {summary.label}
          </span>
          {summary.daysLeft !== null && summary.daysLeft > 0 && (
            <span className="text-sm text-ink-muted">
              <span className="text-lg font-semibold text-ink tabular-nums">
                {summary.daysLeft}
              </span>{' '}
              {summary.daysLeft === 1 ? 'day' : 'days'} left
            </span>
          )}
        </div>
        <p className="text-sm text-ink">{summary.text}</p>
        {subscription && (
          <Facts label="Subscription details" facts={details(subscription, timezone)} />
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Limits">
          <Facts
            label="Limits"
            facts={[
              ['Tables', limit(usage.tables, plan.maxTables)],
              ['Staff logins', limit(usage.staff, plan.maxStaff)],
            ]}
          />
          <p className="text-xs text-ink-muted">
            The owner&apos;s login and waiter profiles without a login don&apos;t count.
          </p>
        </Section>

        <Section title="Included features">
          <ul aria-label="Included features" className="flex flex-col gap-1.5 text-sm">
            {FEATURE_KEYS.map((key) => {
              const included = plan.features[key];
              const Icon = included ? Check : Minus;
              return (
                <li
                  key={key}
                  data-included={included}
                  className={cn(
                    'flex items-center gap-2',
                    included ? 'text-ink' : 'text-ink-muted',
                  )}
                >
                  <Icon
                    aria-hidden
                    className={cn('size-4', included ? 'text-status-served' : 'text-ink-muted')}
                  />
                  {FEATURE_LABELS[key]}
                  <span className="sr-only">{included ? '(included)' : '(not included)'}</span>
                </li>
              );
            })}
          </ul>
        </Section>
      </div>

      <Section title="Payments">
        {payments.length === 0 ? (
          <p className="text-sm text-ink-muted">No payments yet.</p>
        ) : (
          <Table aria-label="Payments">
            <TableHeader>
              <TableRow>
                <TableHead>Paid on</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Covers</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell>{formatDay(payment.paidAt, timezone)}</TableCell>
                  <TableCell>
                    <Money paise={payment.amountPaise} />
                  </TableCell>
                  <TableCell>
                    {PAYMENT_METHOD_LABELS[payment.manualMode ?? payment.source] ?? payment.source}
                  </TableCell>
                  <TableCell>
                    {formatPaidPeriod(payment.periodStart, payment.periodEnd, timezone)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <p className="text-sm text-ink-muted">
        Paying online is coming soon. Until then, contact support to pay by bank transfer or UPI, or
        to change your plan.
      </p>
    </>
  );
}

function details(subscription: OwnerSubscription, timezone: string): [string, ReactNode][] {
  const { plan } = subscription;
  const facts: [string, ReactNode][] = [];

  if (subscription.status === 'trialing') {
    facts.push([
      'Trial ends',
      subscription.trialEndsAt ? formatDay(subscription.trialEndsAt, timezone) : '—',
    ]);
    facts.push([
      'Price after the trial',
      <>
        <Money paise={plan.priceMonthlyPaise} /> a month or <Money paise={plan.priceYearlyPaise} />{' '}
        a year
      </>,
    ]);
    return facts;
  }

  const yearly = subscription.billingCycle === 'yearly';
  facts.push([
    'Price',
    <>
      <Money paise={yearly ? plan.priceYearlyPaise : plan.priceMonthlyPaise} />{' '}
      {yearly ? 'a year' : 'a month'}
    </>,
  ]);
  facts.push([
    'Payment',
    subscription.source === 'razorpay'
      ? 'Automatic (Razorpay)'
      : subscription.source
        ? 'Paid through support'
        : '—',
  ]);
  facts.push([
    'Paid period',
    formatPaidPeriod(subscription.currentPeriodStart, subscription.currentPeriodEnd, timezone),
  ]);
  if (subscription.currentPeriodEnd && subscription.status === 'active') {
    facts.push(
      subscription.cancelAtPeriodEnd
        ? ['Ends after', lastDay(subscription.currentPeriodEnd, timezone)]
        : ['Next payment due', formatDay(subscription.currentPeriodEnd, timezone)],
    );
  }
  if (subscription.graceUntil) {
    facts.push(['Pay by', formatDay(subscription.graceUntil, timezone)]);
  }
  return facts;
}

function limit(used: number, max: number | null): string {
  return max === null ? `${used} (no limit)` : `${used} of ${max}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `section-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <h2 id={id} className="text-base font-semibold text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Facts({ facts, label }: { facts: [string, ReactNode][]; label: string }) {
  return (
    <dl aria-label={label} className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {facts.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-ink-muted">{term}</dt>
          <dd className="text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
