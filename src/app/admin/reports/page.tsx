import { ChartColumn } from 'lucide-react';
import type { Metadata } from 'next';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Reports',
};

export default async function ReportsPage() {
  await requireMember(ADMIN_PANEL_ROLES);

  return (
    <>
      <PageHeader title="Reports" />
      <EmptyState
        icon={ChartColumn}
        title="No reports yet"
        description="Sales, item and waiter reports will show here once bills are generated."
        className="flex-1"
      />
    </>
  );
}
