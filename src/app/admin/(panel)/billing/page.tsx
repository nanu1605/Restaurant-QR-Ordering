import { ReceiptIndianRupee } from 'lucide-react';
import type { Metadata } from 'next';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Billing',
};

export default async function BillingPage() {
  await requireMember(ADMIN_PANEL_ROLES);

  return (
    <>
      <PageHeader title="Billing" />
      <EmptyState
        icon={ReceiptIndianRupee}
        title="Nothing to bill yet"
        description="Tables with open orders will be listed here, ready to generate a bill."
        className="flex-1"
      />
    </>
  );
}
