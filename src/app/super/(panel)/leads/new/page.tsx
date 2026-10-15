import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { NewLeadForm } from '@/features/growth/components/new-lead-form';
import { Breadcrumbs } from '@/features/platform/components/breadcrumbs';
import { getTeam } from '@/features/platform/queries';
import { requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Add lead',
};

/** A lead from a field visit, a call, a referral or a message (docs/DECISIONS.md SA-55). */
export default async function NewLeadPage() {
  const user = await requirePlatformPermission('growth.manage');
  const team = await getTeam();

  return (
    <>
      <Breadcrumbs items={[{ href: '/super/leads', label: 'Leads' }]} />
      <PageHeader
        title="Add lead"
        description="Someone the team met, spoke to or was told about. Demo requests from the website come in by themselves."
      />
      <NewLeadForm
        me={team.some((member) => member.user_id === user.id) ? user.id : ''}
        team={team}
      />
    </>
  );
}
