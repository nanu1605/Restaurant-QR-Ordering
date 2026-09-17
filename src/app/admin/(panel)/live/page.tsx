import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { boardKey, getQueryClient } from '@/features/live/query-client';
import { BoardAlerts } from '@/features/orders/components/board-alerts';
import { LiveBoard } from '@/features/orders/components/live-board';
import { getBoard } from '@/features/orders/queries';
import { UnassignedQueue } from '@/features/sessions/components/unassigned-queue';
import { WaiterStrip } from '@/features/sessions/components/waiter-strip';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Live orders',
};

/** Live orders (spec §13.3): the worker panel board plus the manager's tools. */
export default async function LiveOrdersPage() {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const queryClient = getQueryClient();
  queryClient.setQueryData(boardKey(membership.memberId), await getBoard());

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <PageHeader
        title="Live orders"
        description="Every table as it happens: approve orders, assign waiters and fix mistakes."
      />
      <BoardAlerts newSessions />
      <UnassignedQueue />
      <WaiterStrip />
      <LiveBoard mode="admin" />
    </HydrationBoundary>
  );
}
