import { UtensilsCrossed } from 'lucide-react';
import type { Metadata } from 'next';

import { EmptyState } from '@/components/shared/empty-state';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Admin panel',
};

export default async function AdminHomePage() {
  const membership = await requireMember(ADMIN_PANEL_ROLES);

  return (
    <EmptyState
      icon={UtensilsCrossed}
      title={`Welcome, ${membership.displayName}`}
      description="Menu, tables & QR codes, waiters and staff logins are set up here next."
      className="flex-1"
    />
  );
}
