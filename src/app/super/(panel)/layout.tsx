import { PanelHeader } from '@/components/shared/panel-header';
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
      />
      <main className="flex flex-1 flex-col p-4 md:p-6">{children}</main>
    </div>
  );
}
