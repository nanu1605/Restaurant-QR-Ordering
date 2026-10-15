import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Money } from '@/components/shared/money';
import { UsageChart } from '@/features/platform/components/home-charts';
import { ChartPanel, Figure } from '@/features/platform/components/home-sections';
import { NoteItem } from '@/features/platform/components/notes';
import { OnboardingChecklist } from '@/features/platform/components/onboarding-checklist';
import { OwnerPasswordButton } from '@/features/platform/components/restaurant-actions';
import { Section } from '@/features/platform/components/restaurant-sections';
import { StandeesSection } from '@/features/platform/components/standees-section';
import { activityKindsFor, activityLine } from '@/features/platform/home';
import {
  formatDate,
  formatDateTime,
  formatShortDate,
  todayInIndia,
} from '@/features/platform/platform';
import {
  getRestaurantDetail,
  getRestaurantOverview,
  getStandees,
  listActivity,
  listNotes,
} from '@/features/platform/queries';
import { qrShare, restaurantPath } from '@/features/platform/restaurant-page';
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/auth/guards';
import { formatINR } from '@/lib/money';

const noon = (day: string) => `${day}T12:00:00+05:30`;
const linkClass = 'text-sm font-medium text-brand underline-offset-4 hover:underline';

/**
 * A restaurant's Overview (docs/SUPER_ADMIN_PLAN.md 13a, docs/DECISIONS.md
 * SA-35, SA-41, SA-84): its last 30 days in numbers, 90 days of orders and
 * GMV, the onboarding checklist, standees, pinned and latest notes, the latest
 * activity and its owner's login.
 */
export default async function RestaurantOverviewPage({
  params,
}: PageProps<'/super/restaurants/[restaurantId]'>) {
  await requirePlatformPermission('restaurants.view');
  const { restaurantId } = await params;
  const detail = await getRestaurantDetail(restaurantId);
  if (!detail) notFound();
  const [money, support, audit, manage, record] = await Promise.all([
    hasPlatformPermission('money.view'),
    hasPlatformPermission('restaurants.support'),
    hasPlatformPermission('audit.view'),
    hasPlatformPermission('restaurants.manage'),
    hasPlatformPermission('money.record'),
  ]);
  const [overview, notes, activity, standees] = await Promise.all([
    getRestaurantOverview(restaurantId),
    listNotes(restaurantId),
    listActivity({
      restaurantId,
      kinds: activityKindsFor({ money, growth: false, support, audit }),
      limit: 5,
    }),
    getStandees(restaurantId),
  ]);
  const { last_30: last30, days } = overview;
  const average = last30.bills > 0 ? Math.round(last30.gmv_paise / last30.bills) : null;
  const qr = qrShare(last30.customer_orders, last30.staff_orders);
  const pinned = notes.filter((note) => note.pinned);
  const latest = notes.find((note) => !note.pinned);
  const orderDays = days.filter((day) => day.orders > 0 || day.gmv_paise > 0).length;
  const base = restaurantPath(restaurantId);

  return (
    <>
      <section aria-labelledby="numbers-heading" className="flex flex-col gap-2">
        <h2 id="numbers-heading" className="text-lg font-semibold text-ink">
          Last 30 days
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg border border-line bg-surface p-4 sm:grid-cols-3 lg:grid-cols-5">
          <Figure label="Orders">{last30.orders.toLocaleString('en-IN')}</Figure>
          <Figure label="GMV" note="Diners' bills, taxes included">
            <Money paise={last30.gmv_paise} fraction="auto" />
          </Figure>
          <Figure label="Average bill" note={`${last30.bills.toLocaleString('en-IN')} bills`}>
            {average === null ? '—' : <Money paise={average} fraction="auto" />}
          </Figure>
          <Figure label="QR orders" note={qr?.note ?? 'Of accepted orders'}>
            {qr?.value ?? '—'}
          </Figure>
          <Figure
            label="Last active"
            note={detail.last_active ? formatDateTime(detail.last_active) : undefined}
          >
            {detail.last_active ? formatShortDate(detail.last_active) : 'Never'}
          </Figure>
        </dl>
        <p className="text-xs text-ink-muted">
          The 30 business days to {formatDate(noon(overview.last_day))}, the last one the restaurant
          has finished.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <ChartPanel
          id="chart-usage"
          title="Orders and GMV, 90 days"
          description="Accepted orders and what diners paid on MenuMesh bills (taxes included), by business day."
          empty={orderDays === 0 ? 'No orders in the last 90 days.' : null}
          chart={
            <UsageChart
              points={days.map((day) => ({
                label: formatShortDate(noon(day.day)),
                gmvPaise: day.gmv_paise,
                orders: day.orders,
              }))}
              summary={`Orders and GMV for the 90 days to ${formatDate(noon(overview.last_day))}: ${days
                .reduce((sum, day) => sum + day.orders, 0)
                .toLocaleString('en-IN')} orders and ${formatINR(
                days.reduce((sum, day) => sum + day.gmv_paise, 0),
              )}.`}
            />
          }
          table={{
            headers: ['Day', 'Orders', 'GMV'],
            rows: days.map((day) => [
              formatDate(noon(day.day)),
              day.orders,
              <Money key="gmv" paise={day.gmv_paise} fraction="auto" />,
            ]),
          }}
        />

        <div className="flex min-w-0 flex-col gap-4">
          <OnboardingChecklist onboarding={overview.onboarding} />
          <StandeesSection
            restaurantId={restaurantId}
            detail={standees}
            today={todayInIndia()}
            can={{ manage, record, money }}
          />
          <Section
            title="Notes"
            action={
              <Link href={`${base}/notes`} className={linkClass}>
                All notes
              </Link>
            }
          >
            {pinned.length === 0 && !latest ? (
              <p className="text-sm text-ink-muted">
                No notes yet.{manage && ' Add one from Actions.'}
              </p>
            ) : (
              <ul className="-mx-3 -my-2 flex flex-col divide-y divide-line">
                {[...pinned, ...(latest ? [latest] : [])].map((note) => (
                  <NoteItem key={note.id} note={note} canManage={manage} />
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Latest activity"
            action={
              <Link href={`${base}/activity`} className={linkClass}>
                All activity
              </Link>
            }
          >
            {activity.items.length === 0 ? (
              <p className="text-sm text-ink-muted">Nothing yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {activity.items.map((item) => {
                  const line = activityLine(item);
                  return (
                    <li key={item.key} className="flex flex-col text-sm">
                      <span className="text-ink">
                        {line.href ? (
                          <Link
                            href={line.href}
                            className="font-medium text-brand underline-offset-4 hover:underline"
                          >
                            {line.title}
                          </Link>
                        ) : (
                          <span className="font-medium">{line.title}</span>
                        )}
                        {line.detail && <span className="text-ink-muted"> · {line.detail}</span>}
                      </span>
                      <time dateTime={item.at} className="text-xs text-ink-muted tabular-nums">
                        {formatDateTime(item.at)}
                      </time>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Owner login">
            {detail.owners.length === 0 && (
              <p className="text-sm text-ink-muted">No owner login.</p>
            )}
            <ul className="flex flex-col divide-y divide-line empty:hidden">
              {detail.owners.map((owner) => (
                <li
                  key={owner.member_id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium text-ink">
                      {owner.display_name}
                      {!owner.is_active && <span className="text-ink-muted"> (deactivated)</span>}
                    </span>
                    <span className="text-sm [overflow-wrap:anywhere] text-ink-muted">
                      Code {detail.restaurant.slug}, username {owner.username}
                      {owner.email_is_real && owner.email ? `, ${owner.email}` : ''}
                    </span>
                    <span className="text-xs text-ink-muted">
                      Last login {formatDateTime(owner.last_sign_in_at)}
                    </span>
                  </div>
                  {support && (
                    <OwnerPasswordButton
                      memberId={owner.member_id}
                      ownerName={owner.display_name}
                    />
                  )}
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </>
  );
}
