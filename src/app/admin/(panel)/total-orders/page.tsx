import { ClipboardList } from 'lucide-react';
import type { Metadata } from 'next';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Total orders',
};

export default async function TotalOrdersPage() {
  await requireMember(ADMIN_PANEL_ROLES);

  return (
    <>
      <PageHeader title="Total orders" />
      <EmptyState
        icon={ClipboardList}
        title="No bills yet"
        description="Every billed table will be listed here with its invoice, waiter and payment."
        className="flex-1"
      />
    </>
  );
}
