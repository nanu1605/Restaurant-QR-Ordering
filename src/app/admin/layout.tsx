import { PanelHeader } from '@/components/shared/panel-header';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES, ROLE_LABELS } from '@/lib/auth/roles';

export default async function AdminLayout({ children }: LayoutProps<'/admin'>) {
  const membership = await requireMember(ADMIN_PANEL_ROLES);

  return (
    <div className="flex flex-1 flex-col">
      <PanelHeader
        panel="Admin panel"
        title={membership.restaurant.name}
        userName={membership.displayName}
        roleLabel={ROLE_LABELS[membership.role]}
        switchTo={{ href: '/staff', label: 'Worker panel' }}
      />
      <main className="flex flex-1 flex-col p-4 md:p-6">{children}</main>
    </div>
  );
}
