import { ScrollText } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { buttonVariants } from '@/components/ui/button';
import { ActivityFeed } from '@/features/platform/components/home-sections';
import { activityKindsFor, type ActivityKind } from '@/features/platform/home';
import { readActivityParams } from '@/features/platform/params';
import { getRestaurantDetail, listActivity } from '@/features/platform/queries';
import { restaurantPath } from '@/features/platform/restaurant-page';
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/auth/guards';
import { hrefWithParams } from '@/lib/date-range';

export const metadata: Metadata = {
  title: 'Activity',
};

/**
 * A restaurant's timeline (docs/SUPER_ADMIN_PLAN.md 13a, docs/DECISIONS.md
 * SA-33): the activity stream for this restaurant, by kind, newest first.
 */
export default async function RestaurantActivityPage({
  params,
  searchParams,
}: PageProps<'/super/restaurants/[restaurantId]/activity'>) {
  await requirePlatformPermission('restaurants.view');
  const { restaurantId } = await params;
  const detail = await getRestaurantDetail(restaurantId);
  if (!detail) notFound();
  const query = readActivityParams(await searchParams);
  const [money, audit] = await Promise.all([
    hasPlatformPermission('money.view'),
    hasPlatformPermission('audit.view'),
  ]);
  // Leads aren't any restaurant's.
  const kinds = activityKindsFor({ money, growth: false, audit });
  const asked: ActivityKind[] =
    query.kind && kinds.includes(query.kind) ? [query.kind] : [...kinds];
  const page = await listActivity({ restaurantId, kinds: asked, before: query.before }).catch(() =>
    // A cursor from an old link that no longer reads starts again from the newest.
    listActivity({ restaurantId, kinds: asked }),
  );
  const path = restaurantPath(restaurantId, '/activity');

  return (
    <>
      <ActivityFeed
        page={page}
        params={query}
        kinds={kinds}
        heading="Timeline"
        oneRestaurant
        hrefFor={(next) => {
          const merged = { ...query, ...next };
          return hrefWithParams(path, { kind: merged.kind, before: merged.before });
        }}
      />
      {audit && (
        <Link
          href={`/super/audit?restaurant=${restaurantId}`}
          className={buttonVariants({ variant: 'ghost', className: 'h-11 self-start md:h-8' })}
        >
          <ScrollText aria-hidden />
          Audit log
        </Link>
      )}
    </>
  );
}
