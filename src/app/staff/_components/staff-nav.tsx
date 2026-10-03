'use client';

import { cn } from 'cn';
import { ChefHat, LayoutGrid, PackageCheck, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type NavItem = { href: string; label: string; icon: LucideIcon };

/** Worker panel sections (spec §13.2). The kitchen view needs the `kds` plan feature. */
export function StaffNav({ kitchenView }: { kitchenView: boolean }) {
  const pathname = usePathname();
  const items: NavItem[] = [
    { href: '/staff', label: 'Board', icon: LayoutGrid },
    ...(kitchenView ? [{ href: '/staff/kitchen', label: 'Kitchen', icon: ChefHat }] : []),
    { href: '/staff/availability', label: 'Availability', icon: PackageCheck },
  ];

  return (
    <nav
      aria-label="Worker panel sections"
      className="border-b border-line bg-surface px-2 print:hidden"
    >
      <ul className="flex gap-1 overflow-x-auto">
        {items.map(({ href, label, icon: Icon }) => {
          const active = href === '/staff' ? pathname === '/staff' : pathname.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-12 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-base font-medium text-ink-muted hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:gap-2 sm:px-4',
                  active && 'border-brand text-brand hover:text-brand',
                )}
              >
                <Icon aria-hidden className="size-5" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
