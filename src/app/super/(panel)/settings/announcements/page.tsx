import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { AnnouncementsManager } from '@/features/announcements/components/announcements-manager';
import { listAnnouncements } from '@/features/announcements/queries';
import { Breadcrumbs } from '@/features/platform/components/breadcrumbs';
import { listPlans } from '@/features/platform/queries';
import { requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Announcements',
};

// Saving one emails its owners after the response, one at a time, starting none after
// EMAIL_RUN_MS (docs/DECISIONS.md SA-83, VPS-28).
export const maxDuration = 300;

/** Banners in restaurants' panels (docs/SUPER_ADMIN_PLAN.md 14c, docs/DECISIONS.md SA-82+). */
export default async function AnnouncementsPage() {
  await requirePlatformPermission('settings.manage');
  const [{ announcements, cities }, plans] = await Promise.all([listAnnouncements(), listPlans()]);

  return (
    <>
      <Breadcrumbs items={[{ href: '/super/settings', label: 'Platform settings' }]} />
      <PageHeader
        title="Announcements"
        description="A banner in restaurants’ panels for a while, and an email to their owners if you like. Every change is in the audit log."
      />
      <AnnouncementsManager
        announcements={announcements}
        plans={plans.map(({ code, name, is_active }) => ({ code, name, active: is_active }))}
        cities={cities}
      />
    </>
  );
}
