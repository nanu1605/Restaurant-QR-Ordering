import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Money } from '@/components/shared/money';
import { PageHeader } from '@/components/shared/page-header';
import { buttonVariants } from '@/components/ui/button';
import { formatDateTime } from '@/features/platform/platform';
import { getPlatformOverview } from '@/features/platform/queries';
import { requirePlatformAdmin } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Platform overview',
};

/** Overview (spec §13.4): restaurants by state, MRR, orders today, trials ending soon. */
export default async function SuperOverviewPage() {
  await requirePlatformAdmin();
  const overview = await getPlatformOverview();
  const { restaurants } = overview;

  const stats: { label: string; value: number; href: string }[] = [
    { label: 'Restaurants', value: restaurants.total, href: '/super/restaurants' },
    {
      label: 'On trial',
      value: restaurants.trialing,
      href: '/super/subscriptions?status=trialing',
    },
    { label: 'Active', value: restaurants.active, href: '/super/subscriptions?status=active' },
    { label: 'Payment failed', value: restaurants.past_due, href: '/super/subscriptions' },
    { label: 'Read-only', value: restaurants.read_only, href: '/super/restaurants' },
    {
      label: 'Suspended',
      value: restaurants.suspended,
      href: '/super/restaurants?status=suspended',
    },
  ];

  return (
    <>
      <PageHeader
        title="Overview"
        description="Every restaurant on the platform. Read-only means a lapsed trial or subscription."
        actions={
          <Link href="/super/restaurants/new" className={buttonVariants({ size: 'touch' })}>
            <Plus aria-hidden />
            Onboard restaurant
          </Link>
        }
      />

      <dl aria-label="Restaurants" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-lg border border-line bg-surface p-3">
            <dt className="text-sm text-ink-muted">
              <Link href={stat.href} className="underline-offset-4 hover:underline">
                {stat.label}
              </Link>
            </dt>
            <dd className="text-2xl font-semibold text-ink tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>

      <dl aria-label="Revenue and orders" className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface p-3">
          <dt className="text-sm text-ink-muted">MRR</dt>
          <dd className="text-2xl font-semibold text-ink">
            <Money paise={overview.mrr_paise} fraction="auto" />
          </dd>
          <dd className="text-xs text-ink-muted">Paid subscriptions per month; yearly ÷ 12.</dd>
        </div>
        <div className="rounded-lg border border-line bg-surface p-3">
          <dt className="text-sm text-ink-muted">Orders in the last 24 hours</dt>
          <dd className="text-2xl font-semibold text-ink tabular-nums">{overview.orders_24h}</dd>
          <dd className="text-xs text-ink-muted">Across every restaurant.</dd>
        </div>
      </dl>

      <section aria-labelledby="trials-ending" className="flex flex-col gap-2">
        <h2 id="trials-ending" className="text-base font-semibold text-ink">
          Trials ending in the next 7 days
        </h2>
        {overview.trials_ending.length === 0 ? (
          <p className="text-sm text-ink-muted">No trials end this week.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {overview.trials_ending.map((trial) => (
              <li
                key={trial.restaurant_id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <Link
                  href={`/super/restaurants/${trial.restaurant_id}`}
                  className="font-medium text-brand underline-offset-4 hover:underline"
                >
                  {trial.name}
                </Link>
                <span className="text-sm text-ink-muted">
                  {trial.plan_name} trial ends {formatDateTime(trial.trial_ends_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
