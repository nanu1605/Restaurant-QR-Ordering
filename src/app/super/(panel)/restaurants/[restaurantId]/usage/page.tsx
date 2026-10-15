import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Heatmap } from '@/features/platform/components/heatmap';
import { AddOverride, RemoveOverride } from '@/features/platform/components/pricing-controls';
import { Facts, Section } from '@/features/platform/components/restaurant-sections';
import { overrideLabel } from '@/features/platform/offers';
import { formatDate, formatDateTime } from '@/features/platform/platform';
import {
  getRestaurantDetail,
  getRestaurantOverview,
  getRestaurantUsage,
} from '@/features/platform/queries';
import { limitHitLabel } from '@/features/platform/restaurant-page';
import { FeaturesUsed } from '@/features/usage/components/usage-sections';
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Usage',
};

const noon = (day: string) => `${day}T12:00:00+05:30`;
const count = (n: number) => n.toLocaleString('en-IN');
const ofLimit = (n: number, max: number | null | undefined) =>
  max === null || max === undefined ? `${count(n)} (no limit)` : `${count(n)} of ${count(max)}`;

/**
 * A restaurant's Usage tab (docs/SUPER_ADMIN_PLAN.md 13a, docs/DECISIONS.md
 * SA-37): what it uses against its plan's limits, its busy hours and the
 * limits it ran into, and the features it uses, by usage analytics' rules
 * (13e, SA-63).
 */
export default async function RestaurantUsagePage({
  params,
}: PageProps<'/super/restaurants/[restaurantId]/usage'>) {
  await requirePlatformPermission('restaurants.view');
  const { restaurantId } = await params;
  const detail = await getRestaurantDetail(restaurantId);
  if (!detail) notFound();
  const [usage, overview, manage] = await Promise.all([
    getRestaurantUsage(restaurantId),
    getRestaurantOverview(restaurantId),
    hasPlatformPermission('restaurants.manage'),
  ]);
  const { usage: counts, subscription } = detail;
  // Accepted orders by finished business day, as on the Overview (plan §1).
  const last7 = overview.days.slice(-7).reduce((sum, day) => sum + day.orders, 0);

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Usage">
          <Facts
            label="Usage"
            facts={[
              ['Active tables', ofLimit(counts.tables_active, subscription?.max_tables)],
              ['Staff logins', ofLimit(counts.staff_logins, subscription?.max_staff)],
              ['Waiters', count(counts.waiters)],
              ['Orders, last 7 days', count(last7)],
              ['Orders, last 30 days', count(overview.last_30.orders)],
              ['Last order', formatDateTime(counts.last_order_at)],
              ['Bills (last 30 days)', `${count(counts.bills)} (${count(overview.last_30.bills)})`],
            ]}
          />
          <p className="text-xs text-ink-muted">
            {subscription && (
              <>
                Limits are the {subscription.plan_name} plan’s
                {detail.overrides.some((o) => o.kind !== 'feature' && !o.expired)
                  ? ', with the overrides below'
                  : ''}
                .{' '}
              </>
            )}
            Orders are accepted orders, and the last 30 days are business days the restaurant has
            finished, as on the Overview.
          </p>
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

      <Section title="Overrides and beta flags">
        {detail.overrides.length === 0 ? (
          <p className="text-sm text-ink-muted">None: the plan as it is.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line text-sm">
            {detail.overrides.map((override) => (
              <li
                key={override.id}
                className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-ink">
                    {overrideLabel(override)}
                    {override.expired && <span className="text-ink-muted"> (expired)</span>}
                  </span>
                  <span className="text-ink-muted">
                    {override.reason}
                    {override.expires_at &&
                      ` · ${override.expired ? 'ended' : 'until'} ${formatDateTime(override.expires_at)}`}
                    {override.created_by && ` · ${override.created_by}`}
                  </span>
                </span>
                {manage && <RemoveOverride override={override} />}
              </li>
            ))}
          </ul>
        )}
        {manage && <AddOverride restaurantId={restaurantId} />}
      </Section>

      <Section title="Features in use">
        <p className="text-sm text-ink-muted">
          In its last 30 finished business days, {formatDate(noon(usage.features_from))} to{' '}
          {formatDate(noon(usage.features_to))}, as on the Usage page.
        </p>
        <FeaturesUsed used={usage.features} />
      </Section>

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
