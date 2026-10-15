import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { Breadcrumbs } from '@/features/platform/components/breadcrumbs';
import { OffersManager } from '@/features/platform/components/offers-manager';
import { listOffers, listPlans } from '@/features/platform/queries';
import { requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Offers',
};

/** Offer codes (docs/SUPER_ADMIN_PLAN.md 14b, docs/DECISIONS.md SA-77+). */
export default async function OffersPage() {
  await requirePlatformPermission('settings.manage');
  const [offers, plans] = await Promise.all([listOffers(), listPlans()]);

  return (
    <>
      <Breadcrumbs items={[{ href: '/super/settings', label: 'Platform settings' }]} />
      <PageHeader
        title="Offers"
        description="Codes that take a percentage or rupees off a plan, before GST. Every change is in the audit log."
      />
      <OffersManager
        offers={offers}
        plans={plans.filter((plan) => plan.is_active).map(({ code, name }) => ({ code, name }))}
      />
    </>
  );
}
