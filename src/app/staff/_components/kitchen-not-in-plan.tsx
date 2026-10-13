'use client';

import { ChefHat } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { useStaffStrings } from '@/features/orders/staff-lang';

/** Starter restaurants use the board; in the panel's language, like the rest of it. */
export function KitchenNotInPlan({ plan }: { plan: string }) {
  const t = useStaffStrings();
  return (
    <EmptyState
      icon={ChefHat}
      title={t.kitchenNotInPlan.title}
      description={t.kitchenNotInPlan.description(plan)}
      className="flex-1"
    />
  );
}
