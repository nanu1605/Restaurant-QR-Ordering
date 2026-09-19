import { PanelHeader } from '@/components/shared/panel-header';
import { SuperMobileNav, SuperNav } from '@/features/platform/components/super-nav';
import { requirePlatformAdmin } from '@/lib/auth/guards';
import { APP_NAME } from '@/lib/config';

export default async function SuperPanelLayout({ children }: LayoutProps<'/super'>) {
  const user = await requirePlatformAdmin();

  return (
    <div className="flex flex-1 flex-col">
      <PanelHeader
        panel="Platform admin"
        title={APP_NAME}
        userName={user.email ?? 'Platform admin'}
        roleLabel="Platform admin"
        leading={<SuperMobileNav />}
      />
      <div className="flex flex-1">
        <aside className="hidden w-56 shrink-0 border-r border-line bg-surface p-3 md:block print:hidden">
          <SuperNav />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
