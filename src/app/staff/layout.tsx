import { dehydrate, HydrationBoundary } from '@tanstack/react-query';

import { PanelHeader } from '@/components/shared/panel-header';
import { LiveProvider } from '@/features/live/live-provider';
import { LiveStatus } from '@/features/live/live-status';
import { boardKey, getQueryClient } from '@/features/live/query-client';
import { BoardAlerts } from '@/features/orders/components/board-alerts';
import { OfflineBanner } from '@/features/orders/components/offline-banner';
import { getBoard } from '@/features/orders/queries';
import { hasFeature } from '@/features/plans/plan-features';
import { getPlanFeatures } from '@/features/plans/queries';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES, ROLE_LABELS, STAFF_PANEL_ROLES } from '@/lib/auth/roles';

import { StaffNav } from './_components/staff-nav';

export default async function StaffLayout({ children }: LayoutProps<'/staff'>) {
  const membership = await requireMember(STAFF_PANEL_ROLES);
  const canOpenAdmin = (ADMIN_PANEL_ROLES as readonly string[]).includes(membership.role);
  const [plan, board] = await Promise.all([getPlanFeatures(membership.restaurant.id), getBoard()]);

  // Every worker panel page shares the live board, so alerts sound on any of them.
  const queryClient = getQueryClient();
  queryClient.setQueryData(boardKey(membership.memberId), board);

  return (
    <LiveProvider restaurantId={membership.restaurant.id} memberId={membership.memberId}>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <div className="flex flex-1 flex-col">
          <PanelHeader
            panel="Worker panel"
            title={membership.restaurant.name}
            userName={membership.displayName}
            roleLabel={ROLE_LABELS[membership.role]}
            switchTo={canOpenAdmin ? { href: '/admin', label: 'Admin panel' } : undefined}
          >
            <LiveStatus />
          </PanelHeader>
          <StaffNav kitchenView={hasFeature(plan, 'kds')} />
          <BoardAlerts />
          <OfflineBanner className="mx-4 mt-4" />
          <main className="flex flex-1 flex-col p-4">{children}</main>
        </div>
      </HydrationBoundary>
    </LiveProvider>
  );
}
