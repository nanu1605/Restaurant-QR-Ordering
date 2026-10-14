import { PanelHeader } from '@/components/shared/panel-header';
import { PanelAnalytics } from '@/features/analytics/panel-analytics';
import { SuperMobileNav, SuperNav } from '@/features/platform/components/super-nav';
import { SuperSearch } from '@/features/platform/components/super-search';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { APP_NAME } from '@/lib/config';

export default async function SuperPanelLayout({ children }: LayoutProps<'/super'>) {
  const user = await requirePlatformAdmin();

  return (
    <div className="flex flex-1 flex-col">
      <PanelAnalytics userId={user.id} role="platform_admin" restaurantId={null} />
      <PanelHeader
        panel="Platform admin"
        title={APP_NAME}
        userName={user.email ?? 'Platform admin'}
        roleLabel="Platform admin"
        leading={<SuperMobileNav />}
      >
        <SuperSearch />
      </PanelHeader>
      <div className="flex flex-1">
        <aside className="hidden w-56 shrink-0 border-r border-line bg-surface lg:block print:hidden">
          <div className="sticky top-0 max-h-dvh overflow-y-auto p-3">
            <SuperNav />
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 lg:px-6 lg:py-5">{children}</main>
      </div>
    </div>
  );
}
