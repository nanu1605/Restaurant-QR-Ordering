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
import { AccessBadge, SubscriptionBadge } from '@/features/platform/components/status-badges';
import {
  ACCESS_REASON_LABELS,
  formatDate,
  formatDateTime,
  formatPeriod,
  MANUAL_MODE_LABELS,
  PAYMENT_SOURCE_LABELS,
  SUPPORT_SECTION_LABELS,
  SUPPORT_SECTIONS,
  todayInIndia,
  type RestaurantDetail,
} from '@/features/platform/platform';
import { listMenuImports } from '@/features/menu-import/queries';
import { getRestaurantDetail, listPlans } from '@/features/platform/queries';
import { requirePlatformAdmin } from '@/lib/auth/guards';

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
  const [detail, plans] = await Promise.all([getRestaurantDetail(restaurantId), listPlans()]);
  if (!detail) notFound();
  const imports = await listMenuImports(restaurantId, 5);
  const { restaurant, subscription, access, usage } = detail;

  return (
    <>
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
            paymentStart={firstUnpaidDay(detail)}
          />
        }
      />

      {restaurant.status === 'suspended' && (
        <p role="status" className="rounded-lg border-2 border-destructive bg-surface p-3 text-ink">
          Suspended: {restaurant.suspended_reason}
        </p>
      )}

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
        <Link
          href={`/super/restaurants/${restaurant.id}/menu-import`}
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          <FileUp aria-hidden />
          Import menu
        </Link>
      </nav>

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
              ['Onboarded', formatDate(restaurant.created_at)],
            ]}
          />
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
          <Table aria-label="Payments">
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
          <Table aria-label="Menu imports">
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

/**
 * The first business day a new payment would pay for: after the trial or the
 * paid period when either still runs, otherwise today (India).
 */
function firstUnpaidDay({ subscription, access }: RestaurantDetail): string {
  const today = todayInIndia();
  let covered: string | null = null;
  if (subscription?.status === 'trialing') covered = access.restriction_at;
  else if (subscription?.status === 'active') covered = subscription.current_period_end;
  const day = covered ? todayInIndia(new Date(covered)) : today;
  return day > today ? day : today;
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
