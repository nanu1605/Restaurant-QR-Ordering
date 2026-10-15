import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Money } from '@/components/shared/money';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DealControls } from '@/features/platform/components/pricing-controls';
import { Facts, Section } from '@/features/platform/components/restaurant-sections';
import { dealPriceLine, type DealRow } from '@/features/platform/offers';
import {
  ACCESS_REASON_LABELS,
  DUES_BUCKET_LABELS,
  formatDate,
  formatDateTime,
  formatPeriod,
  MANUAL_MODE_LABELS,
  PAYMENT_PURPOSE_LABELS,
  periodLastDay,
  PAYMENT_SOURCE_LABELS,
  REMINDER_LABELS,
  RENEWAL_KIND_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  type RestaurantDetail,
} from '@/features/platform/platform';
import { getRestaurantBilling, getRestaurantDetail, listPlans } from '@/features/platform/queries';
import {
  historyLine,
  linkLabel,
  type RestaurantBilling,
} from '@/features/platform/restaurant-page';
import { autopayState } from '@/features/subscriptions/autopay';
import { CANCEL_REASON_LABELS } from '@/features/subscriptions/cancel-reasons';
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Billing',
};

/**
 * A restaurant's Billing tab (docs/SUPER_ADMIN_PLAN.md 13a, docs/DECISIONS.md
 * SA-36): its subscription and access, where it stands in Dues, payments,
 * links and reminders sent, and the subscription's history.
 */
export default async function RestaurantBillingPage({
  params,
}: PageProps<'/super/restaurants/[restaurantId]/billing'>) {
  await requirePlatformPermission('restaurants.view');
  const { restaurantId } = await params;
  const detail = await getRestaurantDetail(restaurantId);
  if (!detail) notFound();
  const [billing, plans, record] = await Promise.all([
    getRestaurantBilling(restaurantId),
    listPlans(),
    hasPlatformPermission('money.record'),
  ]);
  const planNames = Object.fromEntries(plans.map((plan) => [plan.code, plan.name]));

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <SubscriptionSection detail={detail} />
        <div className="flex min-w-0 flex-col gap-4">
          <DuesSection dues={billing.dues} suspended={detail.restaurant.status === 'suspended'} />
          <Section title="Access">
            <Facts
              facts={[
                ['State', detail.access.state === 'full' ? 'Full access' : 'Read-only'],
                [
                  'Why',
                  detail.access.reason
                    ? (ACCESS_REASON_LABELS[detail.access.reason] ?? detail.access.reason)
                    : '—',
                ],
                ['Restricted from', formatDateTime(detail.access.restriction_at)],
              ]}
            />
          </Section>
        </div>
      </div>

      <PriceSection
        detail={detail}
        plans={plans
          .filter((plan) => plan.is_active)
          .map((plan) => ({
            code: plan.code,
            name: plan.name,
            monthlyPaise: plan.price_monthly_paise,
            yearlyPaise: plan.price_yearly_paise,
          }))}
        canRecord={record}
      />

      {detail.money && <PaymentsSection payments={detail.payments} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Payment links sent">
          {billing.links.length === 0 ? (
            <p className="text-sm text-ink-muted">No payment links sent.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line text-sm">
              {billing.links.map((link, index) => (
                <li
                  key={`${link.at}-${index}`}
                  className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0"
                >
                  <span className="text-ink">
                    {linkLabel(link)}
                    {link.paid_at ? (
                      <span className="font-medium"> · Paid {formatDateTime(link.paid_at)}</span>
                    ) : (
                      <span className="text-ink-muted"> · Not paid</span>
                    )}
                  </span>
                  <span className="[overflow-wrap:anywhere] text-ink-muted">
                    Sent {formatDateTime(link.at)}
                    {link.actor && ` by ${link.actor}`}
                    {link.short_url && (
                      <>
                        {', '}
                        <a
                          href={link.short_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand underline underline-offset-4"
                        >
                          {link.short_url}
                        </a>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Reminders emailed">
          {billing.reminders.length === 0 ? (
            <p className="text-sm text-ink-muted">No reminders sent.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line text-sm">
              {billing.reminders.map((reminder, index) => (
                <li
                  key={`${reminder.sent_at}-${index}`}
                  className="flex flex-wrap justify-between gap-x-4 py-2 first:pt-0 last:pb-0"
                >
                  <span className="text-ink">
                    {REMINDER_LABELS[reminder.kind] ?? reminder.kind}
                  </span>
                  <span className="text-ink-muted tabular-nums">
                    {formatDateTime(reminder.sent_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Plan and subscription history">
        {billing.history.length === 0 ? (
          <p className="text-sm text-ink-muted">No changes yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line text-sm">
            {billing.history.map((entry, index) => (
              <li
                key={`${entry.at}-${index}`}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 py-2 first:pt-0 last:pb-0"
              >
                <time dateTime={entry.at} className="text-ink-muted tabular-nums sm:w-44">
                  {formatDateTime(entry.at)}
                </time>
                <span className="min-w-0 flex-1 basis-60 text-ink">
                  {historyLine(entry, planNames, formatDate)}
                  {entry.reason && <span className="text-ink-muted">: {entry.reason}</span>}
                  {entry.actor && <span className="text-ink-muted"> · {entry.actor}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function SubscriptionSection({ detail }: { detail: RestaurantDetail }) {
  const { subscription } = detail;
  if (!subscription) {
    return (
      <Section title="Subscription">
        <p className="text-sm text-ink-muted">No subscription.</p>
      </Section>
    );
  }
  const autopay = autopayState({
    razorpayStatus: subscription.razorpay_status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });
  const facts: [string, string][] = [
    ['Status', SUBSCRIPTION_STATUS_LABELS[subscription.status]],
    ['Plan', subscription.plan_name],
    [
      'Billing',
      subscription.billing_cycle
        ? `${subscription.billing_cycle === 'yearly' ? 'Yearly' : 'Monthly'}${
            subscription.source
              ? `, ${PAYMENT_SOURCE_LABELS[subscription.source] ?? subscription.source}`
              : ''
          }`
        : '—',
    ],
    subscription.status === 'trialing'
      ? ['Trial ends', formatDateTime(subscription.trial_ends_at)]
      : [
          'Paid period',
          formatPeriod(subscription.current_period_start, subscription.current_period_end),
        ],
    ['Grace until', formatDateTime(subscription.grace_until)],
    ['Cancels at period end', subscription.cancel_at_period_end ? 'Yes' : 'No'],
    [
      'Razorpay',
      subscription.razorpay_subscription_id
        ? `${subscription.razorpay_subscription_id}, ${subscription.razorpay_status ?? 'not set up'}`
        : '—',
    ],
    [
      'Autopay',
      autopay === 'off'
        ? 'Off'
        : `${autopay === 'on' ? 'On' : 'Ends with the paid period'}${
            subscription.next_plan_name && subscription.next_billing_cycle
              ? ` (first payment for ${subscription.next_plan_name}, ${subscription.next_billing_cycle})`
              : ''
          }`,
    ],
  ];
  if (subscription.cancel_reason) {
    // Kept after autopay comes back: then it is only the reason given last time.
    const leaving =
      subscription.cancel_at_period_end ||
      subscription.status === 'cancelled' ||
      subscription.status === 'expired';
    facts.push([
      leaving ? 'Why it is leaving' : 'Reason given when it last left',
      `${CANCEL_REASON_LABELS[subscription.cancel_reason]}${
        subscription.cancel_reason_detail ? `: ${subscription.cancel_reason_detail}` : ''
      }`,
    ]);
  }
  return (
    <Section title="Subscription">
      <Facts facts={facts} />
    </Section>
  );
}

/** "₹699 a month + GST for 3 months · offer LAUNCH20 · A chain of three". */
function describeDeal(deal: DealRow) {
  return [
    dealPriceLine(deal) ?? 'A special price',
    deal.offer_code ? `offer ${deal.offer_code}` : 'agreed price',
    deal.reason,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Its price (docs/SUPER_ADMIN_PLAN.md 14b, docs/DECISIONS.md SA-77+): the list
 * price or a deal, the next autopay's, and a deal waiting for its autopay.
 */
function PriceSection({
  detail,
  plans,
  canRecord,
}: {
  detail: RestaurantDetail;
  plans: React.ComponentProps<typeof DealControls>['plans'];
  canRecord: boolean;
}) {
  const { subscription, open_deal: open } = detail;
  if (!subscription) return null;
  const { deal, next_deal: next } = subscription;
  const facts: [string, string][] = [
    [
      'Price now',
      deal
        ? `${describeDeal(deal)}${deal.ended_at ? ' (ended: charged until its autopay ends)' : ''}`
        : 'The list price',
    ],
  ];
  if (next) facts.push(['Next autopay', describeDeal(next)]);
  if (open) {
    facts.push([
      'Waiting',
      `${describeDeal(open)}, on ${open.plan_name} ${open.billing_cycle}${
        open.by_owner ? ', from the owner’s checkout' : ', for the owner’s next autopay'
      }`,
    ]);
  }
  return (
    <Section title="Price">
      <Facts facts={facts} />
      {canRecord && (
        <DealControls
          restaurantId={detail.restaurant.id}
          plans={plans}
          current={
            subscription.billing_cycle
              ? { planCode: subscription.plan_code, cycle: subscription.billing_cycle }
              : null
          }
          canEnd={open !== null || (deal !== null && deal.ended_at === null)}
        />
      )}
    </Section>
  );
}

function DuesSection({ dues, suspended }: { dues: RestaurantBilling['dues']; suspended: boolean }) {
  if (!dues) {
    return (
      <Section title="Dues">
        <p className="text-sm text-ink-muted">
          {suspended
            ? 'Suspended restaurants are left out of Dues: see the subscription for what it owes.'
            : 'Nothing due in the next 30 days.'}
        </p>
      </Section>
    );
  }
  const facts: [string, React.ReactNode][] = [
    [
      'Where it stands',
      `${DUES_BUCKET_LABELS[dues.bucket]}${
        dues.bucket === 'renewal_due' && dues.renewal_kind
          ? `, ${RENEWAL_KIND_LABELS[dues.renewal_kind].toLowerCase()}`
          : ''
      }`,
    ],
  ];
  if (dues.due_paise !== null) {
    facts.push(['Due, with GST', <Money key="due" paise={dues.due_paise} />]);
  }
  if (dues.bucket === 'payment_failed')
    facts.push(['Grace ends', formatDateTime(dues.grace_until)]);
  if (dues.bucket === 'lapsed')
    facts.push(['Read-only since', formatDateTime(dues.restriction_at)]);
  if (dues.bucket === 'trial_ending')
    facts.push(['Trial ends', formatDateTime(dues.trial_ends_at)]);
  if (dues.bucket === 'renewal_due' && dues.current_period_end) {
    facts.push(['Paid till', formatDate(periodLastDay(dues.current_period_end))]);
  }
  return (
    <Section title="Dues">
      <Facts facts={facts} />
    </Section>
  );
}

function PaymentsSection({ payments }: { payments: RestaurantDetail['payments'] }) {
  return (
    <Section title="Payments">
      {payments.length === 0 ? (
        <p className="text-sm text-ink-muted">No payments yet.</p>
      ) : (
        <Table label="Payments">
          <TableHeader>
            <TableRow>
              <TableHead>Recorded</TableHead>
              <TableHead>For</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">GST</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>How</TableHead>
              <TableHead>Period</TableHead>
              <TableHead>Recorded by</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.map((payment) => (
              <TableRow key={payment.payment_id}>
                <TableCell>{formatDateTime(payment.created_at)}</TableCell>
                <TableCell>
                  {payment.purpose === 'subscription' && payment.plan_name
                    ? `${payment.plan_name}${payment.billing_cycle ? `, ${payment.billing_cycle}` : ''}`
                    : PAYMENT_PURPOSE_LABELS[payment.purpose]}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <Money paise={payment.base_paise} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <Money paise={payment.gst_paise} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <Money paise={payment.amount_paise} />
                </TableCell>
                <TableCell>
                  {payment.manual_mode
                    ? MANUAL_MODE_LABELS[payment.manual_mode]
                    : (PAYMENT_SOURCE_LABELS[payment.source] ?? payment.source)}
                  {payment.razorpay_payment_id && (
                    <span className="block text-xs text-ink-muted">
                      {payment.razorpay_payment_id}
                    </span>
                  )}
                </TableCell>
                <TableCell>{formatPeriod(payment.period_start, payment.period_end)}</TableCell>
                <TableCell>{payment.recorded_by ?? '—'}</TableCell>
                <TableCell className="whitespace-normal">{payment.notes ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}
