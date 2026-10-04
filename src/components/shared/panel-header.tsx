import type { ReactNode } from 'react';

import { AccountMenu } from '@/components/shared/account-menu';
import { LogoMark } from '@/components/shared/logo';

type PanelHeaderProps = {
  /** Panel name, e.g. "Worker panel". */
  panel: string;
  /** Restaurant name (or the product name on the platform panel). */
  title: string;
  userName: string;
  roleLabel: string;
  /** Link to another panel the user can open. */
  switchTo?: { href: string; label: string };
  /** Offer "Install app": the panel links the install manifest (lib/config.ts INSTALLABLE). */
  installable?: boolean;
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
  installable,
  leading,
  children,
}: PanelHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-line bg-surface px-4 py-3 print:hidden">
      <div className="flex min-w-0 items-center gap-2">
        {leading}
        <LogoMark className="hidden size-7 sm:block" />
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-semibold text-brand">{panel}</span>
          <span className="truncate text-base font-semibold text-ink">{title}</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {children}
        <AccountMenu
          userName={userName}
          roleLabel={roleLabel}
          switchTo={switchTo}
          installable={installable}
        />
      </div>
    </header>
  );
}
