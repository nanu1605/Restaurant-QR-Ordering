import { HtmlLang } from '@/components/shared/html-lang';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

/** Print pages (spec §15): no admin chrome, no live connection, white paper in either theme. */
export default async function PrintLayout({ children }: LayoutProps<'/admin'>) {
  await requireMember(ADMIN_PANEL_ROLES);
  return (
    <div className="theme-light flex flex-1 flex-col bg-white">
      <HtmlLang lang="en" />
      {children}
    </div>
  );
}
