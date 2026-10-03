'use client';

import { cn } from 'cn';
import {
  Building2,
  CreditCard,
  Inbox,
  LayoutDashboard,
  Menu,
  ScrollText,
  Tags,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

type NavItem = { href: string; label: string; icon: LucideIcon };

// Spec §13.4 sections.
const NAV_ITEMS: NavItem[] = [
  { href: '/super', label: 'Overview', icon: LayoutDashboard },
  { href: '/super/restaurants', label: 'Restaurants', icon: Building2 },
  { href: '/super/leads', label: 'Leads', icon: Inbox },
  { href: '/super/subscriptions', label: 'Subscriptions', icon: CreditCard },
  { href: '/super/plans', label: 'Plans', icon: Tags },
  { href: '/super/webhooks', label: 'Webhooks', icon: Webhook },
  { href: '/super/audit', label: 'Audit log', icon: ScrollText },
];

function isActive(pathname: string, href: string) {
  if (href === '/super') return pathname === '/super';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SuperNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Platform sections">
      <ul className="flex flex-col gap-0.5">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium text-ink-muted transition-colors hover:bg-muted hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                  active && 'bg-accent text-brand hover:bg-accent hover:text-brand',
                )}
              >
                <Icon aria-hidden className="size-4" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The sections in a sheet on narrow screens. */
export function SuperMobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button variant="ghost" size="icon-lg" className="md:hidden" aria-label="Open menu" />
        }
      >
        <Menu aria-hidden />
      </SheetTrigger>
      <SheetContent side="left" className="w-72 p-4">
        <SheetTitle className="px-3 pt-1 text-sm font-semibold text-brand">
          Platform admin
        </SheetTitle>
        <SuperNav onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
