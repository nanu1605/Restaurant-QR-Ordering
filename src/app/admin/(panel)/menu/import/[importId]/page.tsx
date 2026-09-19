import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/shared/page-header';
import { buttonVariants } from '@/components/ui/button';
import { ImportDetailView } from '@/features/menu-import/components/import-views';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Import menu',
};

// Reading a page may take a retry and the fallback reader (docs/DECISIONS.md P7-15).
export const maxDuration = 180;

export default async function MenuImportPage({
  params,
}: PageProps<'/admin/menu/import/[importId]'>) {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const { importId } = await params;

  return (
    <>
      <PageHeader
        title="Import menu"
        actions={
          <Link href="/admin/menu/import" className={buttonVariants({ variant: 'outline' })}>
            <ArrowLeft aria-hidden />
            All imports
          </Link>
        }
      />
      <ImportDetailView
        importId={importId}
        restaurantId={membership.restaurant.id}
        importBasePath="/admin/menu/import"
        menuHref="/admin/menu"
      />
    </>
  );
}
