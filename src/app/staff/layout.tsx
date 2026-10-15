import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PanelHeader } from '@/components/shared/panel-header';
import { PanelAnalytics } from '@/features/analytics/panel-analytics';
import { AnnouncementBanners } from '@/features/announcements/components/announcement-banners';
import { LiveProvider } from '@/features/live/live-provider';
import { LiveStatus } from '@/features/live/live-status';
import { boardKey, getQueryClient } from '@/features/live/query-client';
import { BoardAlerts } from '@/features/orders/components/board-alerts';
import { OfflineBanner } from '@/features/orders/components/offline-banner';
import { getBoard } from '@/features/orders/queries';
import { StaffLangProvider } from '@/features/orders/staff-lang';
import { STAFF_STRINGS } from '@/features/orders/strings';
import { hasFeature } from '@/features/plans/plan-features';
import { getPlanFeatures } from '@/features/plans/queries';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES, STAFF_PANEL_ROLES } from '@/lib/auth/roles';
import { INSTALLABLE } from '@/lib/config';

import { StaffNav } from './_components/staff-nav';

export const metadata: Metadata = INSTALLABLE;

export default async function StaffLayout({ children }: LayoutProps<'/staff'>) {
  const membership = await requireMember(STAFF_PANEL_ROLES);
  // Live service is the restaurant's own; a support session works in /admin (SA-49).
  if (membership.support) redirect('/admin');
  const canOpenAdmin = (ADMIN_PANEL_ROLES as readonly string[]).includes(membership.role);
  const [plan, board] = await Promise.all([getPlanFeatures(membership.restaurant.id), getBoard()]);

  // Every worker panel page shares the live board, so alerts sound on any of them.
  const queryClient = getQueryClient();
  queryClient.setQueryData(boardKey(membership.memberId), board);
  // The login's own language (docs/DECISIONS.md P11-15).
  const lang = membership.uiLang;
  const t = STAFF_STRINGS[lang];

  return (
    <LiveProvider restaurantId={membership.restaurant.id} memberId={membership.memberId}>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <StaffLangProvider lang={lang}>
          <div lang={lang} className="flex flex-1 flex-col">
            <PanelAnalytics
              userId={membership.memberId}
              role={membership.role}
              restaurantId={membership.restaurant.id}
            />
            <PanelHeader
              panel={t.panel}
              title={membership.restaurant.name}
              userName={membership.displayName}
              roleLabel={t.roles[membership.role]}
              switchTo={canOpenAdmin ? { href: '/admin', label: t.adminPanel } : undefined}
              installable
            >
              <LiveStatus />
            </PanelHeader>
            <StaffNav kitchenView={hasFeature(plan, 'kds')} />
            <BoardAlerts />
            <AnnouncementBanners
              restaurantId={membership.restaurant.id}
              panel="worker"
              lang={lang}
              dismissLabel={t.dismissAnnouncement}
              className="mx-4 mt-4"
            />
            <OfflineBanner className="mx-4 mt-4" />
            <main className="flex flex-1 flex-col p-4">{children}</main>
          </div>
        </StaffLangProvider>
      </HydrationBoundary>
    </LiveProvider>
  );
}
