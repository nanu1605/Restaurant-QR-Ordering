'use client';

import { cn } from 'cn';
import {
  Building2,
  ChartColumn,
  ChartLine,
  CreditCard,
  Funnel,
  HandCoins,
  Inbox,
  House,
  LifeBuoy,
  Megaphone,
  Menu,
  Percent,
  ReceiptIndianRupee,
  ScrollText,
  Settings,
  Signpost,
  Tags,
  UsersRound,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

import type { PlatformPermission } from '@/lib/auth/permissions';

import { useAttentionCount } from './alerts-bell';

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** The permission that opens it (docs/SUPER_ADMIN_PLAN.md §3). */
  permission: PlatformPermission;
  /** Current only on this page, not the ones under it. */
  exact?: boolean;
};
type NavGroup = { title: string | null; items: NavItem[] };

// docs/SUPER_ADMIN_PLAN.md §2: a group appears once it has a page (docs/DECISIONS.md SA-3)
// the member's role opens (SA-70).
const NAV: NavGroup[] = [
  {
    title: null,
    items: [
      { href: '/super', label: 'Home', icon: House, permission: 'restaurants.view', exact: true },
    ],
  },
  {
    title: 'Money',
    items: [
      {
        href: '/super/money/payments',
        label: 'Payments',
        icon: ReceiptIndianRupee,
        permission: 'money.view',
      },
      { href: '/super/money/dues', label: 'Dues', icon: HandCoins, permission: 'money.view' },
      {
        href: '/super/money/subscriptions',
        label: 'Subscriptions',
        icon: CreditCard,
        permission: 'restaurants.view',
      },
      { href: '/super/money/revenue', label: 'Revenue', icon: ChartLine, permission: 'money.view' },
    ],
  },
  {
    title: 'Restaurants',
    items: [
      {
        href: '/super/restaurants',
        label: 'Restaurants',
        icon: Building2,
        permission: 'restaurants.view',
      },
      {
        href: '/super/support',
        label: 'Support inbox',
        icon: LifeBuoy,
        permission: 'restaurants.support',
      },
      {
        href: '/super/standees',
        label: 'Standees',
        icon: Signpost,
        permission: 'restaurants.view',
      },
    ],
  },
  {
    title: 'Growth',
    items: [
      { href: '/super/leads', label: 'Leads', icon: Inbox, permission: 'growth.manage' },
      { href: '/super/funnel', label: 'Funnel', icon: Funnel, permission: 'growth.manage' },
    ],
  },
  {
    title: 'Insights',
    items: [
      { href: '/super/usage', label: 'Usage', icon: ChartColumn, permission: 'insights.view' },
    ],
  },
  {
    title: 'System',
    items: [
      { href: '/super/webhooks', label: 'Webhooks', icon: Webhook, permission: 'system.view' },
    ],
  },
  {
    title: 'Settings',
    items: [
      {
        href: '/super/settings',
        label: 'Platform settings',
        icon: Settings,
        permission: 'settings.manage',
        exact: true,
      },
      {
        href: '/super/settings/team',
        label: 'Team',
        icon: UsersRound,
        permission: 'team.manage',
      },
      { href: '/super/plans', label: 'Plans', icon: Tags, permission: 'settings.manage' },
      {
        href: '/super/settings/offers',
        label: 'Offers',
        icon: Percent,
        permission: 'settings.manage',
      },
      {
        href: '/super/settings/announcements',
        label: 'Announcements',
        icon: Megaphone,
        permission: 'settings.manage',
      },
      { href: '/super/audit', label: 'Audit log', icon: ScrollText, permission: 'audit.view' },
    ],
  },
];

function isActive(pathname: string, { href, exact }: NavItem) {
  return pathname === href || (!exact && pathname.startsWith(`${href}/`));
}

/** The groups and pages a member with these permissions can open. */
export function navFor(permissions: readonly string[]): NavGroup[] {
  return NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => permissions.includes(item.permission)),
  })).filter((group) => group.items.length > 0);
}

export function SuperNav({
  permissions,
  onNavigate,
}: {
  permissions: readonly string[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  // The nav renders twice (sidebar and sheet), so headings need unique ids.
  const ids = useId();
  // Needs attention on Home, from the alerts bell's latest look (docs/DECISIONS.md SA-28).
  const attention = useAttentionCount();

  return (
    <nav aria-label="Platform sections" className="flex flex-col gap-4">
      {navFor(permissions).map(({ title, items }, index) => (
        <div key={title ?? 'home'} className="flex flex-col gap-1">
          {title && (
            <p
              id={`${ids}-${index}`}
              className="px-3 text-xs font-semibold tracking-wide text-ink-muted uppercase"
            >
              {title}
            </p>
          )}
          <ul
            aria-labelledby={title ? `${ids}-${index}` : undefined}
            className="flex flex-col gap-0.5"
          >
            {items.map((item) => {
              const { href, label, icon: Icon } = item;
              const active = isActive(pathname, item);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium text-ink-muted transition-colors hover:bg-muted hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none lg:h-9',
                      active && 'bg-accent text-brand hover:bg-accent hover:text-brand',
                    )}
                  >
                    <Icon aria-hidden className="size-4" />
                    {label}
                    {href === '/super' && !!attention && (
                      <span className="ml-auto rounded-full bg-primary px-2 text-xs font-semibold text-primary-foreground tabular-nums">
                        {attention}
                        <span className="sr-only"> need attention</span>
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The sections in a sheet on narrow screens. */
export function SuperMobileNav({ permissions }: { permissions: readonly string[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button variant="ghost" size="icon-touch" className="lg:hidden" aria-label="Open menu" />
        }
      >
        <Menu aria-hidden />
      </SheetTrigger>
      <SheetContent side="left" className="w-72 overflow-y-auto p-4">
        <SheetTitle className="px-3 pt-1 text-sm font-semibold text-brand">
          Platform admin
        </SheetTitle>
        <SuperNav permissions={permissions} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
