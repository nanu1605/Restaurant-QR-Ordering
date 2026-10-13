import type { Metadata } from 'next';

import { KitchenBoard } from '@/features/orders/components/kitchen-board';
import { staffStrings } from '@/features/orders/staff-strings';
import { FEATURE_PLAN, hasFeature } from '@/features/plans/plan-features';
import { getPlanFeatures } from '@/features/plans/queries';
import { requireMember } from '@/lib/auth/guards';
import { STAFF_PANEL_ROLES } from '@/lib/auth/roles';

import { KitchenNotInPlan } from '../_components/kitchen-not-in-plan';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await staffStrings()).nav.kitchen };
}

/** Kitchen view (spec §13.2): plan feature `kds`; Starter restaurants use the board. */
export default async function KitchenPage() {
  const membership = await requireMember(STAFF_PANEL_ROLES);
  const plan = await getPlanFeatures(membership.restaurant.id);

  if (!hasFeature(plan, 'kds')) return <KitchenNotInPlan plan={FEATURE_PLAN.kds} />;
  return <KitchenBoard />;
}
