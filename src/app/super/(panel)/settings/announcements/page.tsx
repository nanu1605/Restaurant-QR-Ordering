import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { AnnouncementsManager } from '@/features/announcements/components/announcements-manager';
import { listAnnouncements, listCities } from '@/features/announcements/queries';
import { Breadcrumbs } from '@/features/platform/components/breadcrumbs';
import { listPlans } from '@/features/platform/queries';
import { requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Announcements',
};

/** Banners in restaurants' panels (docs/SUPER_ADMIN_PLAN.md 14c, docs/DECISIONS.md SA-82+). */
export default async function AnnouncementsPage() {
  await requirePlatformPermission('settings.manage');
  const [announcements, plans, cities] = await Promise.all([
    listAnnouncements(),
    listPlans(),
    listCities(),
  ]);

  return (
    <>
      <Breadcrumbs items={[{ href: '/super/settings', label: 'Platform settings' }]} />
      <PageHeader
        title="Announcements"
        description="A banner in restaurants’ panels for a while, and an email to their owners if you like. Every change is in the audit log."
      />
      <AnnouncementsManager
        announcements={announcements}
        plans={plans.filter((plan) => plan.is_active).map(({ code, name }) => ({ code, name }))}
        cities={cities}
      />
    </>
  );
}
