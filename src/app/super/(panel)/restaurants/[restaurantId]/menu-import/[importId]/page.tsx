import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import Link from 'next/link';

import { ImportDetailView } from '@/features/menu-import/components/import-views';
import { getRestaurantDetail } from '@/features/platform/queries';
import { requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Menu import',
};

// Reading a page may take a retry and the fallback reader (docs/DECISIONS.md P7-15).
export const maxDuration = 180;

export default async function SuperMenuImportPage({
  params,
}: PageProps<'/super/restaurants/[restaurantId]/menu-import/[importId]'>) {
  await requirePlatformPermission('restaurants.support');
  const { restaurantId, importId } = await params;
  const detail = await getRestaurantDetail(restaurantId);
  if (!detail) notFound();
  const basePath = `/super/restaurants/${restaurantId}/menu-import`;

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-ink">Menu import</h2>
        <Link
          href={basePath}
          className="text-sm font-medium text-brand underline-offset-4 hover:underline"
        >
          All menu imports
        </Link>
      </div>
      <ImportDetailView
        importId={importId}
        restaurantId={restaurantId}
        importBasePath={basePath}
        menuHref={`/super/restaurants/${restaurantId}/support/menu`}
        asPlatformAdmin
      />
    </>
  );
}
