import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { getRestaurantSettings } from '@/features/settings/queries';
import { getStaff } from '@/features/staff/queries';
import { WaitersManager } from '@/features/waiters/components/waiters-manager';
import { getWaitersOverview } from '@/features/waiters/queries';
import { getRestaurantAccess } from '@/lib/auth/access';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Waiters',
};

export default async function WaitersPage() {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const [waiters, staff, settings, access] = await Promise.all([
    getWaitersOverview(),
    getStaff(),
    getRestaurantSettings(membership.restaurant.id),
    getRestaurantAccess(membership.restaurant.id),
  ]);
  const freeLogins = staff
    .filter((member) => member.role === 'waiter' && member.isActive && !member.waiterId)
    .map((member) => ({
      memberId: member.memberId,
      displayName: member.displayName,
      username: member.username,
    }));

  return (
    <>
      <PageHeader
        title="Waiters"
        description="The people who serve tables. Switch them on or off duty at the start and end of a shift."
      />
      <WaitersManager
        waiters={waiters}
        freeLogins={freeLogins}
        maxTablesPerWaiter={settings.max_tables_per_waiter}
        restaurantSlug={membership.restaurant.slug}
        readOnly={access.state !== 'full'}
      />
    </>
  );
}
