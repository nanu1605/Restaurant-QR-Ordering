import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { PlanEditor } from '@/features/platform/components/plan-editor';
import { listPlans } from '@/features/platform/queries';
import { requirePlatformAdmin } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Plans',
};

/** Plans editor (spec §13.4, §14.1–14.2). Every change is audited. */
export default async function SuperPlansPage() {
  await requirePlatformAdmin();
  const plans = await listPlans();

  return (
    <>
      <PageHeader
        title="Plans"
        description="Changes apply to every restaurant on the plan straight away. Lower limits never switch off existing tables or staff."
      />
      {plans.map((plan) => (
        <PlanEditor key={plan.id} plan={plan} />
      ))}
    </>
  );
}
