import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { Breadcrumbs } from '@/features/platform/components/breadcrumbs';
import { OnboardWizard } from '@/features/platform/components/onboard-wizard';
import { getTrialDays, listPlans } from '@/features/platform/queries';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { getPublicEnv } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Onboard restaurant',
};

/** Onboarding wizard (spec §13.4, docs/DECISIONS.md P7-9). */
export default async function OnboardRestaurantPage() {
  await requirePlatformAdmin();
  const [plans, trialDays] = await Promise.all([listPlans(), getTrialDays()]);

  return (
    <>
      <Breadcrumbs items={[{ href: '/super/restaurants', label: 'Restaurants' }]} />
      <PageHeader
        title="Onboard restaurant"
        description="Creates the restaurant, its owner login and a free trial. Nothing is charged."
      />
      <OnboardWizard
        plans={plans.filter((plan) => plan.is_active).map(({ code, name }) => ({ code, name }))}
        defaultTrialDays={trialDays}
        loginUrl={`${getPublicEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/login`}
      />
    </>
  );
}
