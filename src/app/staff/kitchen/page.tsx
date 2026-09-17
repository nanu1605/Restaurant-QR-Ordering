import { ChefHat } from 'lucide-react';
import type { Metadata } from 'next';

import { EmptyState } from '@/components/shared/empty-state';
import { KitchenBoard } from '@/features/orders/components/kitchen-board';
import { hasFeature, upgradeHint } from '@/features/plans/plan-features';
import { getPlanFeatures } from '@/features/plans/queries';
import { requireMember } from '@/lib/auth/guards';
import { STAFF_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Kitchen',
};

/** Kitchen view (spec §13.2): plan feature `kds`; Starter restaurants use the board. */
export default async function KitchenPage() {
  const membership = await requireMember(STAFF_PANEL_ROLES);
  const plan = await getPlanFeatures(membership.restaurant.id);

  if (!hasFeature(plan, 'kds')) {
    return (
      <EmptyState
        icon={ChefHat}
        title="The kitchen view isn’t in your plan"
        description={`${upgradeHint('kds')}. The board still shows every order.`}
        className="flex-1"
      />
    );
  }
  return <KitchenBoard />;
}
