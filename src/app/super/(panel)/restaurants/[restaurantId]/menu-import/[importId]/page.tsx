import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/shared/page-header';
import { buttonVariants } from '@/components/ui/button';
import { ImportDetailView } from '@/features/menu-import/components/import-views';
import { getRestaurantDetail } from '@/features/platform/queries';
import { requirePlatformAdmin } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Import menu',
};

// Reading a page may take a retry and the fallback reader (docs/DECISIONS.md P7-15).
export const maxDuration = 180;

export default async function SuperMenuImportPage({
  params,
}: PageProps<'/super/restaurants/[restaurantId]/menu-import/[importId]'>) {
  await requirePlatformAdmin();
  const { restaurantId, importId } = await params;
  const detail = await getRestaurantDetail(restaurantId);
  if (!detail) notFound();
  const basePath = `/super/restaurants/${restaurantId}/menu-import`;

  return (
    <>
      <PageHeader
        title={`Import menu for ${detail.restaurant.name}`}
        actions={
          <Link href={basePath} className={buttonVariants({ variant: 'outline' })}>
            <ArrowLeft aria-hidden />
            All imports
          </Link>
        }
      />
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
