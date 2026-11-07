import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { requestTeamExport } from '@/features/closure/actions';
import { CloseAccountCard } from '@/features/closure/components/close-account-card';
import { DataExportCard } from '@/features/closure/components/data-export-card';
import { getClosure, getTeamExport } from '@/features/closure/queries';
import { getRestaurantDetail } from '@/features/platform/queries';
import { requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Account',
};

// Asking for an export builds it after the response (docs/DECISIONS.md SA-93).
export const maxDuration = 300;

/** A restaurant's data export and closing (docs/SUPER_ADMIN_PLAN.md 14e). */
export default async function RestaurantAccountPage({
  params,
}: PageProps<'/super/restaurants/[restaurantId]/account'>) {
  await requirePlatformPermission('restaurants.close');
  const { restaurantId } = await params;
  const detail = await getRestaurantDetail(restaurantId);
  if (!detail) notFound();
  const { restaurant } = detail;
  const [closure, dataExport] = await Promise.all([
    getClosure(restaurantId),
    getTeamExport(restaurantId, restaurant.slug),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <DataExportCard
        title="Data export"
        dataExport={dataExport}
        request={requestTeamExport.bind(null, restaurantId)}
        shareable
      />
      <CloseAccountCard
        restaurantId={restaurantId}
        name={restaurant.name}
        slug={restaurant.slug}
        closure={closure}
      />
    </div>
  );
}
