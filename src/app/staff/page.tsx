import { LayoutGrid } from 'lucide-react';
import type { Metadata } from 'next';

import { EmptyState } from '@/components/shared/empty-state';
import { requireMember } from '@/lib/auth/guards';
import { STAFF_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Worker panel',
};

export default async function StaffHomePage() {
  await requireMember(STAFF_PANEL_ROLES);

  return (
    <EmptyState
      icon={LayoutGrid}
      title="The live table board is coming soon"
      description="New orders will appear here the moment customers place them."
      className="flex-1"
    />
  );
}
