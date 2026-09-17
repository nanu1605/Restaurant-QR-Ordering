import { LayoutDashboard } from 'lucide-react';
import type { Metadata } from 'next';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Dashboard',
};

export default async function AdminDashboardPage() {
  const membership = await requireMember(ADMIN_PANEL_ROLES);

  return (
    <>
      <PageHeader title={`Welcome, ${membership.displayName}`} />
      <EmptyState
        icon={LayoutDashboard}
        title="Today at a glance"
        description="Sales, open tables and alerts will show here once orders come in. Start by setting up your menu and tables."
        className="flex-1"
      />
    </>
  );
}
