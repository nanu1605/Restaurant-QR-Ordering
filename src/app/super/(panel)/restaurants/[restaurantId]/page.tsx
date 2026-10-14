import { Eye, FileUp, ScrollText } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { Money } from '@/components/shared/money';
import { PageHeader } from '@/components/shared/page-header';
import { buttonVariants } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  OwnerPasswordButton,
  RestaurantActions,
} from '@/features/platform/components/restaurant-actions';
import { Breadcrumbs } from '@/features/platform/components/breadcrumbs';
import { AccessBadge, SubscriptionBadge } from '@/features/platform/components/status-badges';
import {
  ACCESS_REASON_LABELS,
  firstUnpaidDay,
  formatDate,
  formatDateTime,
  formatPeriod,
  LOOKALIKE_REASON_LABELS,
  MANUAL_MODE_LABELS,
  PAYMENT_SOURCE_LABELS,
  SUPPORT_SECTION_LABELS,
  SUPPORT_SECTIONS,
} from '@/features/platform/platform';
import { listMenuImports } from '@/features/menu-import/queries';
import {
  getLookalikes,
  getRestaurantDetail,
  getSetupFee,
  getSignupReview,
  listPlans,
} from '@/features/platform/queries';
import { autopayState } from '@/features/subscriptions/autopay';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { razorpayConfig } from '@/lib/razorpay/razorpay';

export const metadata: Metadata = {
  title: 'Restaurant',
};

const IMPORT_STATUS_LABELS: Record<string, string> = {
  uploaded: 'Reading',
  processing: 'Reading',
  review: 'In review',
  imported: 'Imported',
  failed: 'Failed',
  discarded: 'Discarded',
};

const GST_MODE_LABELS: Record<string, string> = {
  none: 'No GST',
  regular: 'Regular GST',
  composition: 'Composition',
};

/**
 * One restaurant (spec §13.4): profile, owners, plan and subscription,
 * payments, usage, access, the actions and the read-only support view.
 */
export default async function SuperRestaurantPage({
  params,
}: PageProps<'/super/restaurants/[restaurantId]'>) {
  await requirePlatformAdmin();
  const { restaurantId } = await params;
  const [detail, plans, setupFee] = await Promise.all([
    getRestaurantDetail(restaurantId),
    listPlans(),
    getSetupFee(),
  ]);
  if (!detail) notFound();
  const [imports, review, lookalikes] = await Promise.all([
    listMenuImports(restaurantId, 5),
    getSignupReview(restaurantId),
    getLookalikes([restaurantId]),
  ]);
  const similar = lookalikes[restaurantId] ?? [];
  const { restaurant, subscription, access, usage } = detail;
  const autopay = subscription
    ? autopayState({
        razorpayStatus: subscription.razorpay_status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      })
    : 'off';
  const plan = plans.find((p) => p.code === subscription?.plan_code);

  return (
    <>
      <Breadcrumbs items={[{ href: '/super/restaurants', label: 'Restaurants' }]} />
      <PageHeader
        title={restaurant.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>Code {restaurant.slug}</span>
            <SubscriptionBadge status={subscription?.status ?? null} />
            <AccessBadge status={restaurant.status} accessState={access.state} />
          </span>
        }
        actions={
          <RestaurantActions
            restaurantId={restaurant.id}
            restaurantName={restaurant.name}
            status={restaurant.status}
            subscription={
              subscription
                ? { status: subscription.status, planCode: subscription.plan_code }
                : null
            }
            plans={plans.filter((plan) => plan.is_active).map(({ code, name }) => ({ code, name }))}
            paymentStart={firstUnpaidDay(
              subscription && {
                status: subscription.status,
                restrictionAt: access.restriction_at,
                currentPeriodEnd: subscription.current_period_end,
              },
            )}
            razorpay={
              razorpayConfig()
                ? {
                    subscriptionId: subscription?.razorpay_subscription_id ?? null,
                    autopay,
                    linkDefaults: {
                      planName: plan?.name ?? '',
                      monthlyPaise: plan?.price_monthly_paise ?? 0,
                      yearlyPaise: plan?.price_yearly_paise ?? 0,
                      setupFeePaise: setupFee.feePaise - setupFee.discountPaise,
                      setupFeeDiscountPaise: setupFee.discountPaise,
                    },
                  }
                : null
            }
          />
        }
      />

      {restaurant.status === 'suspended' && (
        <p role="status" className="rounded-lg border-2 border-destructive bg-surface p-3 text-ink">
          Suspended: {restaurant.suspended_reason}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Support view" className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">
            <Eye aria-hidden className="mr-1 inline size-4" />
            Look (read-only):
          </span>
          {SUPPORT_SECTIONS.map((section) => (
            <Link
              key={section}
              href={`/super/restaurants/${restaurant.id}/support/${section}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {SUPPORT_SECTION_LABELS[section]}
            </Link>
          ))}
          <Link
            href={`/super/audit?restaurant=${restaurant.id}`}
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            <ScrollText aria-hidden />
            Audit log
          </Link>
        </nav>
        {/* Not a look: an import changes the restaurant's menu. */}
        <Link
          href={`/super/restaurants/${restaurant.id}/menu-import`}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <FileUp aria-hidden />
          Import menu
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Subscription">
          {subscription ? (
            <Facts
              facts={[
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
                      formatPeriod(
                        subscription.current_period_start,
                        subscription.current_period_end,
                      ),
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
              ]}
            />
          ) : (
            <p className="text-sm text-ink-muted">No subscription.</p>
          )}
        </Section>

        <Section title="Access">
          <Facts
            facts={[
              ['State', access.state === 'full' ? 'Full access' : 'Read-only'],
              ['Why', access.reason ? (ACCESS_REASON_LABELS[access.reason] ?? access.reason) : '—'],
              ['Restricted from', formatDateTime(access.restriction_at)],
            ]}
          />
        </Section>

        <Section title="Usage">
          <Facts
            label="Usage"
            facts={[
              ['Active tables', String(usage.tables_active)],
              ['Staff logins', String(usage.staff_logins)],
              ['Waiters', String(usage.waiters)],
              ['Orders, last 7 days', String(usage.orders_7d)],
              ['Orders, last 30 days', String(usage.orders_30d)],
              ['Last order', formatDateTime(usage.last_order_at)],
              ['Bills (last 30 days)', `${usage.bills} (${usage.bills_30d})`],
            ]}
          />
        </Section>

        <Section title="Profile">
          <Facts
            facts={[
              ['Legal name', restaurant.legal_name ?? '—'],
              [
                'Address',
                [restaurant.address_line, restaurant.city, restaurant.state, restaurant.pincode]
                  .filter(Boolean)
                  .join(', ') || '—',
              ],
              ['Phone', restaurant.phone ?? '—'],
              ['Email', restaurant.email ?? '—'],
              [
                'GST',
                `${GST_MODE_LABELS[restaurant.gst_mode] ?? restaurant.gst_mode}${restaurant.gstin ? `, ${restaurant.gstin}` : ''}`,
              ],
              ['FSSAI licence', review.fssaiLicense ?? '—'],
              ['Onboarded', formatDate(restaurant.created_at)],
            ]}
          />
        </Section>

        {/* What the website's signup sent, for the one-trial check (docs/DECISIONS.md P11-12). */}
        <Section title="Storefront photo">
          {review.photoUrl ? (
            <a href={review.photoUrl} target="_blank" rel="noopener" className="self-start">
              {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link */}
              <img
                src={review.photoUrl}
                alt={`Front of ${restaurant.name}`}
                className="max-h-64 w-auto max-w-full rounded-md border border-line object-cover"
              />
            </a>
          ) : (
            <p className="text-sm text-ink-muted">
              No photo: restaurants onboarded here, or signed up before the photo was asked for,
              have none.
            </p>
          )}
        </Section>

        <Section title="Possible duplicates">
          {similar.length === 0 ? (
            <p className="text-sm text-ink-muted">None found.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line text-sm">
              {similar.map((other) => (
                <li key={other.restaurant_id} className="flex flex-col py-2 first:pt-0 last:pb-0">
                  <Link
                    href={`/super/restaurants/${other.restaurant_id}`}
                    className="font-medium text-ink underline underline-offset-4"
                  >
                    {other.name}
                  </Link>
                  <span className="text-ink-muted">
                    {[other.slug, other.city].filter(Boolean).join(', ')}:{' '}
                    {other.reasons.map((reason) => LOOKALIKE_REASON_LABELS[reason]).join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Owner">
        <ul className="flex flex-col divide-y divide-line">
          {detail.owners.map((owner) => (
            <li
              key={owner.member_id}
              className="flex flex-wrap items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
            >
              <div className="flex flex-col">
                <span className="font-medium text-ink">
                  {owner.display_name}
                  {!owner.is_active && <span className="text-ink-muted"> (deactivated)</span>}
                </span>
                <span className="text-sm text-ink-muted">
                  Code {restaurant.slug}, username {owner.username}
                  {owner.email_is_real && owner.email ? `, ${owner.email}` : ''}
                </span>
                <span className="text-xs text-ink-muted">
                  Last login {formatDateTime(owner.last_sign_in_at)}
                </span>
              </div>
              <OwnerPasswordButton memberId={owner.member_id} ownerName={owner.display_name} />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Payments">
        {detail.payments.length === 0 ? (
          <p className="text-sm text-ink-muted">No payments yet.</p>
        ) : (
          <Table label="Payments">
            <TableHeader>
              <TableRow>
                <TableHead>Recorded</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>How</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.payments.map((payment) => (
                <TableRow key={payment.payment_id}>
                  <TableCell>{formatDateTime(payment.created_at)}</TableCell>
                  <TableCell>
                    <Money paise={payment.amount_paise} />
                  </TableCell>
                  <TableCell>
                    {payment.manual_mode
                      ? MANUAL_MODE_LABELS[payment.manual_mode]
                      : (PAYMENT_SOURCE_LABELS[payment.source] ?? payment.source)}
                  </TableCell>
                  <TableCell>{formatPeriod(payment.period_start, payment.period_end)}</TableCell>
                  <TableCell className="whitespace-normal">{payment.notes ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title="Menu imports">
        {imports.length === 0 ? (
          <p className="text-sm text-ink-muted">No menu imports yet.</p>
        ) : (
          <Table label="Menu imports">
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Dishes</TableHead>
                <TableHead>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {imports.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Link
                      href={`/super/restaurants/${restaurant.id}/menu-import/${item.id}`}
                      className="text-brand underline-offset-4 hover:underline"
                    >
                      {formatDateTime(item.createdAt)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {item.source === 'photo' ? `${item.pageCount} photo pages` : 'CSV'}
                  </TableCell>
                  <TableCell>{IMPORT_STATUS_LABELS[item.status]}</TableCell>
                  <TableCell>{item.items ?? '—'}</TableCell>
                  <TableCell>
                    {item.source === 'csv' ? (
                      '—'
                    ) : item.costPaise === null ? (
                      'Unknown'
                    ) : (
                      <Money paise={item.costPaise} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </>
  );
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

function Facts({ facts, label }: { facts: [string, string][]; label?: string }) {
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
