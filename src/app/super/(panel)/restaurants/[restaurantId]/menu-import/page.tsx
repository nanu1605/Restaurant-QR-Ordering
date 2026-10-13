import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/shared/page-header';
import { ImportStartView } from '@/features/menu-import/components/import-views';
import { Breadcrumbs } from '@/features/platform/components/breadcrumbs';
import { getRestaurantDetail } from '@/features/platform/queries';
import { requirePlatformAdmin } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Import menu',
};

/** A platform admin imports a restaurant's menu for it (docs/DECISIONS.md P7-19). */
export default async function SuperImportMenuPage({
  params,
}: PageProps<'/super/restaurants/[restaurantId]/menu-import'>) {
  await requirePlatformAdmin();
  const { restaurantId } = await params;
  const detail = await getRestaurantDetail(restaurantId);
  if (!detail) notFound();

  return (
    <>
      <Breadcrumbs
        items={[
          { href: '/super/restaurants', label: 'Restaurants' },
          { href: `/super/restaurants/${restaurantId}`, label: detail.restaurant.name },
        ]}
      />
      <PageHeader
        title={`Import menu for ${detail.restaurant.name}`}
        description="The restaurant's owner sees the dishes on their Menu page once imported. Each import is in its audit log."
      />
      <ImportStartView
        restaurantId={restaurantId}
        importBasePath={`/super/restaurants/${restaurantId}/menu-import`}
        readOnly={detail.access.state !== 'full'}
        showCost
      />
    </>
  );
}
