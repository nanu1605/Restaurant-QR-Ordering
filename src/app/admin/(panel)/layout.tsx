import type { Metadata } from 'next';

import { PanelHeader } from '@/components/shared/panel-header';
import { PanelAnalytics } from '@/features/analytics/panel-analytics';
import { AnnouncementBanners } from '@/features/announcements/components/announcement-banners';
import { LiveProvider } from '@/features/live/live-provider';
import { LiveStatus } from '@/features/live/live-status';
import { OfflineBanner } from '@/features/orders/components/offline-banner';
import { accessBanner } from '@/features/subscriptions/access-banner';
import { SupportSessionBanner } from '@/features/support/components/support-session-banner';
import { getRestaurantAccess } from '@/lib/auth/access';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES, ROLE_LABELS } from '@/lib/auth/roles';
import { INSTALLABLE } from '@/lib/config';

import { AccessBanner } from './_components/access-banner';
import { AdminMobileNav, AdminNav } from './_components/admin-nav';

export const metadata: Metadata = INSTALLABLE;

export default async function AdminLayout({ children }: LayoutProps<'/admin'>) {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const access = await getRestaurantAccess(membership.restaurant.id);
  const banner = accessBanner({
    access,
    role: membership.role,
    timezone: membership.restaurant.timezone,
  });
  // A MenuMesh team member in a support session (docs/DECISIONS.md SA-48): not
  // the restaurant's usage, no Get help as the restaurant, and a way back.
  const support = membership.support;

  return (
    <LiveProvider restaurantId={membership.restaurant.id} memberId={membership.memberId}>
      <div className="flex flex-1 flex-col">
        {!support && (
          <PanelAnalytics
            userId={membership.memberId}
            role={membership.role}
            restaurantId={membership.restaurant.id}
          />
        )}
        <PanelHeader
          panel="Admin panel"
          title={membership.restaurant.name}
          userName={membership.displayName}
          roleLabel={support ? 'MenuMesh support' : ROLE_LABELS[membership.role]}
          switchTo={
            support
              ? { href: `/super/restaurants/${membership.restaurant.id}`, label: 'MenuMesh admin' }
              : { href: '/staff', label: 'Worker panel' }
          }
          installable
          help={support ? undefined : '/admin/help'}
          leading={<AdminMobileNav role={membership.role} />}
        >
          <LiveStatus />
        </PanelHeader>
        <div className="flex flex-1">
          <aside className="hidden w-56 shrink-0 border-r border-line bg-surface p-3 lg:block print:hidden">
            <AdminNav role={membership.role} />
          </aside>
          <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-6 print:p-0">
            {support && (
              <div className="print:hidden">
                <SupportSessionBanner
                  restaurantId={membership.restaurant.id}
                  restaurantName={membership.restaurant.name}
                  endsAt={support.endsAt}
                  timezone={membership.restaurant.timezone}
                />
              </div>
            )}
            {banner && (
              <div className="print:hidden">
                <AccessBanner banner={banner} />
              </div>
            )}
            <AnnouncementBanners
              restaurantId={membership.restaurant.id}
              panel="admin"
              className="print:hidden"
            />
            <OfflineBanner className="print:hidden" />
            {children}
          </main>
        </div>
      </div>
    </LiveProvider>
  );
}
