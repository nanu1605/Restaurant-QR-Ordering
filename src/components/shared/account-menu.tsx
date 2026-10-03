'use client';

import { ArrowLeftRight, ChevronDown, CircleUser, LogOut } from 'lucide-react';
import Link from 'next/link';
import { useRef } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeRadioGroup } from '@/features/theme/theme-switch';

const ITEM = 'min-h-11 px-2';

type AccountMenuProps = {
  userName: string;
  roleLabel: string;
  /** Link to another panel the user can open. */
  switchTo?: { href: string; label: string };
};

/** Who is signed in, the other panel, the theme and Log out, in one menu. */
export function AccountMenu({ userName, roleLabel, switchTo }: AccountMenuProps) {
  const logout = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={logout} action="/logout" method="post" hidden />
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" className="h-11 gap-2 px-2.5" />}>
          <CircleUser aria-hidden className="size-6 sm:hidden" />
          {/* On phones only the icon shows; the name still labels the button. */}
          <span className="sr-only text-right sm:not-sr-only sm:block">
            <span className="block text-sm font-medium text-ink">{userName}</span>
            <span className="block text-xs font-normal text-ink-muted">{roleLabel}</span>
          </span>
          <ChevronDown aria-hidden className="hidden size-4 text-ink-muted sm:block" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-medium text-ink">{userName}</p>
            <p className="text-xs text-ink-muted">{roleLabel}</p>
          </div>
          <DropdownMenuSeparator />
          {switchTo && (
            <>
              <DropdownMenuLinkItem
                closeOnClick
                render={<Link href={switchTo.href} />}
                className={ITEM}
              >
                <ArrowLeftRight aria-hidden />
                {switchTo.label}
              </DropdownMenuLinkItem>
              <DropdownMenuSeparator />
            </>
          )}
          <ThemeRadioGroup itemClassName={ITEM} />
          <DropdownMenuSeparator />
          <DropdownMenuItem className={ITEM} onClick={() => logout.current?.requestSubmit()}>
            <LogOut aria-hidden />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
