import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { Breadcrumbs } from '@/features/platform/components/breadcrumbs';
import { TeamManager } from '@/features/platform/components/team-manager';
import { listTeam } from '@/features/platform/queries';
import { requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Team',
};

/**
 * The MenuMesh team (docs/SUPER_ADMIN_PLAN.md 13g, docs/DECISIONS.md SA-70+):
 * members, their roles, invites and turning members off.
 */
export default async function TeamPage() {
  await requirePlatformPermission('team.manage');
  const members = await listTeam();

  return (
    <>
      <Breadcrumbs items={[{ href: '/super/settings', label: 'Platform settings' }]} />
      <PageHeader
        title="Team"
        description="Who can open this panel, and what their role lets them do. Every change is in the audit log."
      />
      <TeamManager members={members} />
    </>
  );
}
