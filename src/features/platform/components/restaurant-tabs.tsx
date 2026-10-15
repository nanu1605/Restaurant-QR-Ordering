'use client';

import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';

import { buttonVariants } from '@/components/ui/button';

import { RESTAURANT_TABS, restaurantPath } from '../restaurant-page';

/**
 * A restaurant's tabs (docs/DECISIONS.md SA-33): links to its pages, the
 * current one marked, scrolling sideways on a phone.
 */
export function RestaurantTabs({
  restaurantId,
  menuImports,
}: {
  restaurantId: string;
  /** Menu imports need restaurants.support (docs/SUPER_ADMIN_PLAN.md §3). */
  menuImports: boolean;
}) {
  const segment = useSelectedLayoutSegment();
  return (
    <nav aria-label="Restaurant sections" className="-mx-1 min-w-0 overflow-x-auto px-1 pb-1">
      <ul className="flex min-w-max gap-1 border-b border-line">
        {RESTAURANT_TABS.filter((tab) => menuImports || tab.segment !== 'menu-import').map(
          (tab) => {
            const current = tab.segment === segment;
            return (
              <li key={tab.label}>
                <Link
                  href={restaurantPath(restaurantId, tab.path)}
                  aria-current={current ? 'page' : undefined}
                  className={buttonVariants({
                    variant: 'ghost',
                    className: `h-11 rounded-b-none border-0 border-b-2 md:h-9 ${
                      current
                        ? 'border-brand font-semibold text-ink'
                        : 'border-transparent text-ink-muted'
                    }`,
                  })}
                >
                  {tab.label}
                </Link>
              </li>
            );
          },
        )}
      </ul>
    </nav>
  );
}
