import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { Dashboard } from '@/features/dashboard/components/dashboard';
import { FirstSteps } from '@/features/dashboard/components/first-steps';
import { billingKey, boardKey, getQueryClient } from '@/features/live/query-client';
import { getBoard } from '@/features/orders/queries';
import { getSalesReport } from '@/features/reports/queries';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Dashboard',
};

/** Dashboard (spec §13.3): today's sales, the tables right now and what needs attention. */
export default async function AdminDashboardPage() {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const queryClient = getQueryClient();
  // Today's sales are a head start only: if they fail here, the page fetches them itself.
  const [board, sales] = await Promise.all([getBoard(), getSalesReport().catch(() => null)]);
  queryClient.setQueryData(boardKey(membership.memberId), board);
  if (sales) queryClient.setQueryData([...billingKey(membership.memberId), 'today'], sales);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <PageHeader
        title={`Welcome, ${membership.displayName}`}
        description="Today at a glance, with the tables as they are right now."
      />
      {membership.role === 'owner' && <FirstSteps restaurantId={membership.restaurant.id} />}
      <Dashboard />
    </HydrationBoundary>
  );
}
