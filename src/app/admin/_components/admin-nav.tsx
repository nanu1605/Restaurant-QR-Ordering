'use client';

import { cn } from 'cn';
import {
  Activity,
  ChartColumn,
  ClipboardList,
  CreditCard,
  KeyRound,
  LayoutDashboard,
  Menu,
  QrCode,
  ReceiptIndianRupee,
  Settings,
  Users,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import type { MemberRole } from '@/lib/auth/roles';

type NavItem = { href: string; label: string; icon: LucideIcon; ownerOnly?: boolean };

// Spec §13.3 navigation order.
const NAV_ITEMS: NavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/live', label: 'Live orders', icon: Activity },
  { href: '/admin/billing', label: 'Billing', icon: ReceiptIndianRupee },
  { href: '/admin/total-orders', label: 'Total orders', icon: ClipboardList },
  { href: '/admin/reports', label: 'Reports', icon: ChartColumn },
  { href: '/admin/menu', label: 'Menu', icon: UtensilsCrossed },
  { href: '/admin/tables', label: 'Tables & QR', icon: QrCode },
  { href: '/admin/waiters', label: 'Waiters', icon: Users },
  { href: '/admin/staff', label: 'Staff logins', icon: KeyRound },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
  { href: '/admin/subscription', label: 'Subscription', icon: CreditCard, ownerOnly: true },
];

function isActive(pathname: string, href: string) {
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminNav({ role, onNavigate }: { role: MemberRole; onNavigate?: () => void }) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((item) => !item.ownerOnly || role === 'owner');

  return (
    <nav aria-label="Admin sections">
      <ul className="flex flex-col gap-0.5">
        {items.map(({ href, label, icon: Icon }) => {
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

/** Sidebar navigation in a sheet for narrow screens. */
export function AdminMobileNav({ role }: { role: MemberRole }) {
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
        <SheetTitle className="px-3 pt-1 text-sm font-semibold text-brand">Admin panel</SheetTitle>
        <AdminNav role={role} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
