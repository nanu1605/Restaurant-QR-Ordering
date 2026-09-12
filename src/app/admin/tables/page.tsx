import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { getPlanFeatures } from '@/features/plans/queries';
import { TablesManager } from '@/features/tables/components/tables-manager';
import { getAdminTables } from '@/features/tables/queries';
import { getRestaurantAccess } from '@/lib/auth/access';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Tables & QR',
};

export default async function TablesPage() {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const [tables, plan, access] = await Promise.all([
    getAdminTables(),
    getPlanFeatures(membership.restaurant.id),
    getRestaurantAccess(membership.restaurant.id),
  ]);

  return (
    <>
      <PageHeader
        title="Tables & QR"
        description="Each table has its own QR code. Customers scan it to see the menu and order."
      />
      <TablesManager
        tables={tables}
        maxTables={plan.maxTables}
        isOwner={membership.role === 'owner'}
        readOnly={access.state !== 'full'}
      />
    </>
  );
}
