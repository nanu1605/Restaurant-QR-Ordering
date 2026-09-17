import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { BillingSessionsList } from '@/features/billing/components/billing-sessions-list';
import { getBillingSessions } from '@/features/billing/queries';
import { billingKey, getQueryClient } from '@/features/live/query-client';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Billing',
};

/** Billing (spec §13.3): open tables, each with its running total, ready to bill. */
export default async function BillingPage() {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const queryClient = getQueryClient();
  queryClient.setQueryData(
    [...billingKey(membership.memberId), 'sessions'],
    await getBillingSessions(),
  );

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <PageHeader
        title="Billing"
        description="Open tables with their running totals. Choose one to generate its bill."
      />
      <BillingSessionsList />
    </HydrationBoundary>
  );
}
