import { Activity } from 'lucide-react';
import type { Metadata } from 'next';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Live orders',
};

export default async function LiveOrdersPage() {
  await requireMember(ADMIN_PANEL_ROLES);

  return (
    <>
      <PageHeader title="Live orders" />
      <EmptyState
        icon={Activity}
        title="No live orders yet"
        description="Orders from customers and staff will appear here as they come in."
        className="flex-1"
      />
    </>
  );
}
