import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Heatmap } from '@/features/platform/components/heatmap';
import { Facts, Section } from '@/features/platform/components/restaurant-sections';
import { formatDate, formatDateTime } from '@/features/platform/platform';
import { getRestaurantDetail, getRestaurantUsage } from '@/features/platform/queries';
import { limitHitLabel } from '@/features/platform/restaurant-page';
import { requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Usage',
};

const noon = (day: string) => `${day}T12:00:00+05:30`;
const ofLimit = (count: number, max: number | null | undefined) =>
  max === null || max === undefined ? `${count} (no limit)` : `${count} of ${max}`;

/**
 * A restaurant's Usage tab (docs/SUPER_ADMIN_PLAN.md 13a, docs/DECISIONS.md
 * SA-37): what it uses against its plan's limits, its busy hours and the
 * limits it ran into. Features in use arrive with usage analytics (13e).
 */
export default async function RestaurantUsagePage({
  params,
}: PageProps<'/super/restaurants/[restaurantId]/usage'>) {
  await requirePlatformPermission('restaurants.view');
  const { restaurantId } = await params;
  const detail = await getRestaurantDetail(restaurantId);
  if (!detail) notFound();
  const usage = await getRestaurantUsage(restaurantId);
  const { usage: counts, subscription } = detail;

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Usage">
          <Facts
            label="Usage"
            facts={[
              ['Active tables', ofLimit(counts.tables_active, subscription?.max_tables)],
              ['Staff logins', ofLimit(counts.staff_logins, subscription?.max_staff)],
              ['Waiters', String(counts.waiters)],
              ['Orders, last 7 days', String(counts.orders_7d)],
              ['Orders, last 30 days', String(counts.orders_30d)],
              ['Last order', formatDateTime(counts.last_order_at)],
              ['Bills (last 30 days)', `${counts.bills} (${counts.bills_30d})`],
            ]}
          />
          {subscription && (
            <p className="text-xs text-ink-muted">
              Limits are the {subscription.plan_name} plan’s.
            </p>
          )}
        </Section>

        <Section title="Plan limits reached, 90 days">
          {usage.limit_hits.length === 0 ? (
            <p className="text-sm text-ink-muted">None: nothing was refused for the plan.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line text-sm">
              {usage.limit_hits.map((hit) => (
                <li
                  key={`${hit.kind}-${hit.feature ?? ''}`}
                  className="flex flex-col py-2 first:pt-0 last:pb-0"
                >
                  <span className="text-ink">{limitHitLabel(hit)}</span>
                  <span className="text-ink-muted">
                    {hit.count} {hit.count === 1 ? 'time' : 'times'}, last on{' '}
                    {formatDateTime(hit.last_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Busy hours">
        <p className="text-sm text-ink-muted">
          Accepted orders by weekday and hour, {formatDate(noon(usage.from))} to{' '}
          {formatDate(noon(usage.to))}, on the restaurant’s clock. Late-night hours belong to the
          business day they started in.
        </p>
        {usage.hours.length === 0 ? (
          <p className="text-sm text-ink-muted">No orders in these twelve weeks.</p>
        ) : (
          <Heatmap
            label="Orders by weekday and hour"
            cells={usage.hours.map((cell) => ({
              weekday: cell.weekday,
              hour: cell.hour,
              value: cell.orders,
            }))}
            startHour={usage.start_hour}
            describe={(orders) =>
              `${orders.toLocaleString('en-IN')} ${orders === 1 ? 'order' : 'orders'}`
            }
          />
        )}
      </Section>
    </>
  );
}
