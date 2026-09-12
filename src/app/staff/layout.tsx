import { PanelHeader } from '@/components/shared/panel-header';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES, ROLE_LABELS, STAFF_PANEL_ROLES } from '@/lib/auth/roles';

export default async function StaffLayout({ children }: LayoutProps<'/staff'>) {
  const membership = await requireMember(STAFF_PANEL_ROLES);
  const canOpenAdmin = (ADMIN_PANEL_ROLES as readonly string[]).includes(membership.role);

  return (
    <div className="flex flex-1 flex-col">
      <PanelHeader
        panel="Worker panel"
        title={membership.restaurant.name}
        userName={membership.displayName}
        roleLabel={ROLE_LABELS[membership.role]}
        switchTo={canOpenAdmin ? { href: '/admin', label: 'Admin panel' } : undefined}
      />
      <main className="flex flex-1 flex-col p-4">{children}</main>
    </div>
  );
}
