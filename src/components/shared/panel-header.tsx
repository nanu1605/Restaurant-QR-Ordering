import { LogOut } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth/actions';

type PanelHeaderProps = {
  /** Panel name, e.g. "Worker panel". */
  panel: string;
  /** Restaurant name (or the product name on the platform panel). */
  title: string;
  userName: string;
  roleLabel: string;
  /** Link to another panel the user can open. */
  switchTo?: { href: string; label: string };
  /** Before the title, e.g. the navigation button on narrow screens. */
  leading?: ReactNode;
  /** Extra controls, e.g. the connection indicator on live screens. */
  children?: ReactNode;
};

export function PanelHeader({
  panel,
  title,
  userName,
  roleLabel,
  switchTo,
  leading,
  children,
}: PanelHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-line bg-surface px-4 py-3 print:hidden">
      <div className="flex min-w-0 items-center gap-2">
        {leading}
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-semibold text-brand">{panel}</span>
          <span className="truncate text-base font-semibold text-ink">{title}</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {children}
        {switchTo && (
          <Link
            href={switchTo.href}
            className="text-sm font-medium text-brand underline-offset-4 hover:underline"
          >
            {switchTo.label}
          </Link>
        )}
        <div className="hidden text-right sm:block">
          <p className="text-sm font-medium text-ink">{userName}</p>
          <p className="text-xs text-ink-muted">{roleLabel}</p>
        </div>
        <form action={signOut}>
          <Button type="submit" variant="outline" size="lg">
            <LogOut aria-hidden />
            Log out
          </Button>
        </form>
      </div>
    </header>
  );
}
