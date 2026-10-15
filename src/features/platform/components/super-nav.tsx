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
  Menu,
  ReceiptIndianRupee,
  ScrollText,
  Settings,
  Tags,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

import { useAttentionCount } from './alerts-bell';

type NavItem = { href: string; label: string; icon: LucideIcon };
type NavGroup = { title: string | null; items: NavItem[] };

// docs/SUPER_ADMIN_PLAN.md §2: a group appears once it has a page (docs/DECISIONS.md SA-3).
const NAV: NavGroup[] = [
  { title: null, items: [{ href: '/super', label: 'Home', icon: House }] },
  {
    title: 'Money',
    items: [
      { href: '/super/money/payments', label: 'Payments', icon: ReceiptIndianRupee },
      { href: '/super/money/dues', label: 'Dues', icon: HandCoins },
      { href: '/super/money/subscriptions', label: 'Subscriptions', icon: CreditCard },
      { href: '/super/money/revenue', label: 'Revenue', icon: ChartLine },
    ],
  },
  {
    title: 'Restaurants',
    items: [
      { href: '/super/restaurants', label: 'Restaurants', icon: Building2 },
      { href: '/super/support', label: 'Support inbox', icon: LifeBuoy },
    ],
  },
  {
    title: 'Growth',
    items: [
      { href: '/super/leads', label: 'Leads', icon: Inbox },
      { href: '/super/funnel', label: 'Funnel', icon: Funnel },
    ],
  },
  { title: 'Insights', items: [{ href: '/super/usage', label: 'Usage', icon: ChartColumn }] },
  { title: 'System', items: [{ href: '/super/webhooks', label: 'Webhooks', icon: Webhook }] },
  {
    title: 'Settings',
    items: [
      { href: '/super/settings', label: 'Platform settings', icon: Settings },
      { href: '/super/plans', label: 'Plans', icon: Tags },
      { href: '/super/audit', label: 'Audit log', icon: ScrollText },
    ],
  },
];

function isActive(pathname: string, href: string) {
  if (href === '/super') return pathname === '/super';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SuperNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  // The nav renders twice (sidebar and sheet), so headings need unique ids.
  const ids = useId();
  // Needs attention on Home, from the alerts bell's latest look (docs/DECISIONS.md SA-28).
  const attention = useAttentionCount();

  return (
    <nav aria-label="Platform sections" className="flex flex-col gap-4">
      {NAV.map(({ title, items }, index) => (
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
            {items.map(({ href, label, icon: Icon }) => {
              const active = isActive(pathname, href);
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
export function SuperMobileNav() {
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
        <SuperNav onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
