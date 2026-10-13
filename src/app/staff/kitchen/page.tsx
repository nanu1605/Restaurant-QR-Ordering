import { ChefHat } from 'lucide-react';
import type { Metadata } from 'next';

import { EmptyState } from '@/components/shared/empty-state';
import { KitchenBoard } from '@/features/orders/components/kitchen-board';
import { staffStrings } from '@/features/orders/staff-strings';
import { FEATURE_PLAN, hasFeature } from '@/features/plans/plan-features';
import { getPlanFeatures } from '@/features/plans/queries';
import { requireMember } from '@/lib/auth/guards';
import { STAFF_PANEL_ROLES } from '@/lib/auth/roles';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await staffStrings()).nav.kitchen };
}

/** Kitchen view (spec §13.2): plan feature `kds`; Starter restaurants use the board. */
export default async function KitchenPage() {
  const membership = await requireMember(STAFF_PANEL_ROLES);
  const plan = await getPlanFeatures(membership.restaurant.id);

  if (!hasFeature(plan, 'kds')) {
    const t = await staffStrings();
    return (
      <EmptyState
        icon={ChefHat}
        title={t.kitchenNotInPlan.title}
        description={t.kitchenNotInPlan.description(FEATURE_PLAN.kds)}
        className="flex-1"
      />
    );
  }
  return <KitchenBoard />;
}
