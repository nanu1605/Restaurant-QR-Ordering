import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ImportStartView } from '@/features/menu-import/components/import-views';
import { getRestaurantDetail } from '@/features/platform/queries';
import { requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Menu imports',
};

/**
 * A platform admin imports a restaurant's menu for it (docs/DECISIONS.md
 * P7-19), on the Menu imports tab with the earlier imports.
 */
export default async function SuperImportMenuPage({
  params,
}: PageProps<'/super/restaurants/[restaurantId]/menu-import'>) {
  await requirePlatformPermission('restaurants.support');
  const { restaurantId } = await params;
  const detail = await getRestaurantDetail(restaurantId);
  if (!detail) notFound();

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-ink">Import a menu</h2>
        <p className="text-sm text-ink-muted">
          The restaurant&apos;s owner sees the dishes on their Menu page once imported. Each import
          is in its audit log.
        </p>
      </div>
      <ImportStartView
        restaurantId={restaurantId}
        importBasePath={`/super/restaurants/${restaurantId}/menu-import`}
        readOnly={detail.access.state !== 'full'}
        showCost
      />
    </>
  );
}
