import { HtmlLang } from '@/components/shared/html-lang';
import { PanelHeader } from '@/components/shared/panel-header';
import { PanelAnalytics } from '@/features/analytics/panel-analytics';
import { AlertsBell } from '@/features/platform/components/alerts-bell';
import { SuperMobileNav, SuperNav } from '@/features/platform/components/super-nav';
import { SuperSearch } from '@/features/platform/components/super-search';
import { TEAM_ROLE_LABELS } from '@/features/platform/team';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { getPlatformAccess } from '@/lib/auth/session';
import { APP_NAME } from '@/lib/config';

export default async function SuperPanelLayout({ children }: LayoutProps<'/super'>) {
  const user = await requirePlatformAdmin();
  const access = await getPlatformAccess();
  const permissions = access?.permissions ?? [];

  return (
    <div className="flex flex-1 flex-col">
      <HtmlLang lang="en" />
      <PanelAnalytics userId={user.id} role="platform_admin" restaurantId={null} />
      <PanelHeader
        panel="Platform admin"
        title={APP_NAME}
        userName={access?.display_name ?? user.email ?? 'Platform admin'}
        roleLabel={access ? TEAM_ROLE_LABELS[access.role] : 'Platform admin'}
        leading={<SuperMobileNav permissions={permissions} />}
      >
        <SuperSearch />
        <AlertsBell />
      </PanelHeader>
      <div className="flex flex-1">
        <aside className="hidden w-56 shrink-0 border-r border-line bg-surface lg:block print:hidden">
          <div className="sticky top-0 max-h-dvh overflow-y-auto p-3">
            <SuperNav permissions={permissions} />
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 lg:px-6 lg:py-5">{children}</main>
      </div>
    </div>
  );
}
