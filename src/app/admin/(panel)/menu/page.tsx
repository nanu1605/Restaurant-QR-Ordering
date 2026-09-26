import { FileUp } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/shared/page-header';
import { buttonVariants } from '@/components/ui/button';
import { MenuEditor } from '@/features/menu/components/menu-editor';
import { getAdminMenu } from '@/features/menu/queries';
import { getRestaurantAccess } from '@/lib/auth/access';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { getPublicEnv } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Menu',
};

export default async function MenuPage() {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const [menu, access] = await Promise.all([
    getAdminMenu(),
    getRestaurantAccess(membership.restaurant.id),
  ]);

  return (
    <>
      <PageHeader
        title="Menu"
        description="Categories and dishes as customers see them. Drag to reorder."
        actions={
          access.state === 'full' && (
            <Link href="/admin/menu/import" className={buttonVariants({ variant: 'outline' })}>
              <FileUp aria-hidden />
              Import menu
            </Link>
          )
        }
      />
      <MenuEditor
        categories={menu.categories}
        items={menu.items}
        addonGroups={menu.addonGroups}
        supabaseUrl={getPublicEnv().NEXT_PUBLIC_SUPABASE_URL}
        readOnly={access.state !== 'full'}
      />
    </>
  );
}
