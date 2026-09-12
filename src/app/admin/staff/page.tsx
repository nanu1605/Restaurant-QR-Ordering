import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { getPlanFeatures } from '@/features/plans/queries';
import { StaffManager } from '@/features/staff/components/staff-manager';
import { getStaff } from '@/features/staff/queries';
import { getRestaurantAccess } from '@/lib/auth/access';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { getPublicEnv } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Staff logins',
};

export default async function StaffLoginsPage() {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const [staff, plan, access] = await Promise.all([
    getStaff(),
    getPlanFeatures(membership.restaurant.id),
    getRestaurantAccess(membership.restaurant.id),
  ]);

  return (
    <>
      <PageHeader
        title="Staff logins"
        description="Logins for people who use the worker or admin panel. Waiters without a login are managed under Waiters."
      />
      <StaffManager
        staff={staff}
        actorRole={membership.role}
        actorMemberId={membership.memberId}
        maxStaff={plan.maxStaff}
        restaurantSlug={membership.restaurant.slug}
        loginUrl={`${getPublicEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/login`}
        timezone={membership.restaurant.timezone}
        readOnly={access.state !== 'full'}
      />
    </>
  );
}
