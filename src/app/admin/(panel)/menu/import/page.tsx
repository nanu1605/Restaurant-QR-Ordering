import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/shared/page-header';
import { buttonVariants } from '@/components/ui/button';
import { ImportStartView } from '@/features/menu-import/components/import-views';
import { getRestaurantAccess } from '@/lib/auth/access';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Import menu',
};

/** Import a menu from photos, a PDF or a CSV file (spec §20A, owner and manager). */
export default async function ImportMenuPage() {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const access = await getRestaurantAccess(membership.restaurant.id);

  return (
    <>
      <PageHeader
        title="Import menu"
        description="Read the dishes from photos of the printed menu or a CSV file, check them, then add them to the menu."
        actions={
          <Link href="/admin/menu" className={buttonVariants({ variant: 'outline' })}>
            <ArrowLeft aria-hidden />
            Menu
          </Link>
        }
      />
      <ImportStartView
        restaurantId={membership.restaurant.id}
        importBasePath="/admin/menu/import"
        readOnly={access.state !== 'full'}
      />
    </>
  );
}
