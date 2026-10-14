import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Money } from '@/components/shared/money';
import { PageHeader } from '@/components/shared/page-header';
import { buttonVariants } from '@/components/ui/button';
import {
  MrrChart,
  NewRestaurantsChart,
  UsageChart,
} from '@/features/platform/components/home-charts';
import {
  ActivityFeed,
  ChartPanel,
  homeHref,
  KeyNumbers,
} from '@/features/platform/components/home-sections';
import { NeedsAttention } from '@/features/platform/components/needs-attention';
import { activityKindsFor, type ActivityKind } from '@/features/platform/home';
import { readHomeParams } from '@/features/platform/params';
import { duesLinkDefaults } from '@/features/platform/payment-links';
import { formatDate, formatShortDate, todayInIndia } from '@/features/platform/platform';
import {
  getHome,
  getNeedsAttention,
  getSetupFee,
  listActivity,
  listPlans,
} from '@/features/platform/queries';
import { formatINR } from '@/lib/money';
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/auth/guards';
import { razorpayConfig } from '@/lib/razorpay/razorpay';

export const metadata: Metadata = {
  title: 'Home',
};

const noon = (day: string) => `${day}T12:00:00+05:30`;
const dayLabel = (day: string) => formatShortDate(noon(day));
// A year of MRR: the axis needs the year too ("Oct 25").
const monthLabel = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  month: 'short',
  year: '2-digit',
});

/**
 * Home (docs/SUPER_ADMIN_PLAN.md 12e, docs/DECISIONS.md SA-27 to SA-30): key
 * numbers, what needs attention, three charts and the activity stream.
 */
export default async function SuperHomePage({ searchParams }: PageProps<'/super'>) {
  await requirePlatformPermission('restaurants.view');
  const params = readHomeParams(await searchParams);
  const [money, growth, support, audit] = await Promise.all([
    hasPlatformPermission('money.view'),
    hasPlatformPermission('growth.manage'),
    hasPlatformPermission('restaurants.support'),
    hasPlatformPermission('audit.view'),
  ]);
  const kinds = activityKindsFor({ money, growth, support, audit });
  const activityKinds: ActivityKind[] | undefined = params.kind ? [params.kind] : [...kinds];
  const [home, attention, activity, plans, setupFee] = await Promise.all([
    getHome(params.period),
    getNeedsAttention(),
    // A cursor from an old link that no longer reads starts again from the newest.
    listActivity({ kinds: activityKinds, before: params.before }).catch(() =>
      listActivity({ kinds: activityKinds }),
    ),
    listPlans(),
    getSetupFee(),
  ]);
  const today = todayInIndia();
  const { charts } = home;
  const historyNote = home.history_starts_on
    ? `MRR history starts on ${formatDate(home.history_starts_on)}, when daily snapshots began.`
    : 'MRR history starts with the first nightly snapshot, at 3 am.';
  const usageDays = charts.usage.filter((day) => day.orders > 0 || day.gmv_paise > 0).length;
  const newTotal = charts.new_restaurants.reduce((sum, week) => sum + week.signup + week.team, 0);
  const mrrPoints = charts.mrr ?? [];

  return (
    <>
      <PageHeader
        title="Home"
        description="Money, restaurants and what needs doing today, in India time."
        actions={
          <Link href="/super/restaurants/new" className={buttonVariants({ size: 'touch' })}>
            <Plus aria-hidden />
            Onboard restaurant
          </Link>
        }
      />

      <KeyNumbers home={home} params={params} today={today} />

      <NeedsAttention
        attention={attention}
        linkDefaults={duesLinkDefaults(plans, setupFee, razorpayConfig() !== null)}
      />

      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {charts.mrr && (
          <ChartPanel
            id="chart-mrr"
            title="MRR, 12 months"
            description={`Each night's MRR before GST. ${historyNote}`}
            empty={mrrPoints.length < 2 ? historyNote : null}
            chart={
              <MrrChart
                points={mrrPoints.map((point) => ({
                  label: monthLabel.format(new Date(noon(point.day))),
                  title: formatDate(noon(point.day)),
                  mrrPaise: point.mrr_paise,
                }))}
                summary={`MRR from ${formatDate(noon(mrrPoints[0]?.day ?? today))} to today, now ${formatINR(home.mrr_paise ?? 0)}.`}
              />
            }
            table={{
              headers: ['Day', 'MRR'],
              rows: mrrPoints.map((point) => [
                formatDate(`${point.day}T12:00:00+05:30`),
                <Money key="mrr" paise={point.mrr_paise} fraction="auto" />,
              ]),
            }}
          />
        )}
        <ChartPanel
          id="chart-usage"
          title="GMV and orders, 30 days"
          description="What diners paid on MenuMesh bills (taxes included) and accepted orders, by business day."
          empty={usageDays === 0 ? 'No orders in the last 30 days.' : null}
          chart={
            <UsageChart
              points={charts.usage.map((day) => ({
                label: dayLabel(day.day),
                gmvPaise: day.gmv_paise,
                orders: day.orders,
              }))}
              summary={`GMV and orders for the 30 days to ${dayLabel(charts.usage.at(-1)?.day ?? today)}: ${formatINR(charts.usage.reduce((sum, day) => sum + day.gmv_paise, 0))} and ${charts.usage.reduce((sum, day) => sum + day.orders, 0).toLocaleString('en-IN')} orders.`}
            />
          }
          table={{
            headers: ['Day', 'GMV', 'Orders'],
            rows: charts.usage.map((day) => [
              formatDate(`${day.day}T12:00:00+05:30`),
              <Money key="gmv" paise={day.gmv_paise} fraction="auto" />,
              day.orders,
            ]),
          }}
        />
        <ChartPanel
          id="chart-new"
          title="New restaurants, weekly"
          description="Signups from the website and restaurants the team onboarded, by India week from Monday."
          empty={newTotal === 0 ? 'No new restaurants in the last 12 weeks.' : null}
          chart={
            <NewRestaurantsChart
              points={charts.new_restaurants.map((week) => ({
                label: dayLabel(week.week),
                signup: week.signup,
                team: week.team,
              }))}
              summary={`${newTotal} new restaurants in 12 weeks: ${charts.new_restaurants.reduce((sum, week) => sum + week.signup, 0)} signed up, the rest onboarded by the team.`}
            />
          }
          table={{
            headers: ['Week of', 'Signed up', 'Onboarded'],
            rows: charts.new_restaurants.map((week) => [
              formatDate(`${week.week}T12:00:00+05:30`),
              week.signup,
              week.team,
            ]),
          }}
        />
      </div>

      <ActivityFeed
        page={activity}
        params={params}
        kinds={kinds}
        hrefFor={(next) => homeHref(params, next)}
      />
    </>
  );
}
