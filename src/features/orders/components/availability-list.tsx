'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageCheck, Search } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/shared/empty-state';
import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useLive } from '@/features/live/live-provider';
import { menuKey } from '@/features/live/query-client';
import { setItemAvailability } from '@/features/menu/actions';
import { filterMenu } from '@/features/ordering/menu-filter';
import type { CustomerCategory, CustomerMenuItem } from '@/features/ordering/types';
import { createClient } from '@/lib/supabase/browser';

import { fetchStaffMenu } from '../staff-menu';

function withAvailability(menu: CustomerCategory[], id: string, available: boolean) {
  return menu.map((category) => ({
    ...category,
    items: category.items.map((item) =>
      item.id === id ? { ...item, isAvailable: available } : item,
    ),
  }));
}

/** Availability (spec §13.2): every dish with an in-stock switch, searchable. */
export function AvailabilityList() {
  const ids = useId();
  const queryClient = useQueryClient();
  const { restaurantId } = useLive();
  const key = menuKey(restaurantId);
  const [search, setSearch] = useState('');

  const menu = useQuery({
    queryKey: key,
    queryFn: () => fetchStaffMenu(createClient()),
    staleTime: 60_000,
  });

  const toggle = useMutation({
    mutationFn: async ({ item, available }: { item: CustomerMenuItem; available: boolean }) => {
      const result = await setItemAvailability(item.id, available);
      if (!result.ok) throw new Error(result.error);
    },
    onMutate: async ({ item, available }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<CustomerCategory[]>(key);
      queryClient.setQueryData<CustomerCategory[]>(key, (current) =>
        current ? withAvailability(current, item.id, available) : current,
      );
      return { previous };
    },
    onSuccess: (_result, { item, available }) => {
      toast.success(available ? `${item.name} is back in stock` : `${item.name} is out of stock`);
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      toast.error(error instanceof Error ? error.message : 'Something went wrong. Try again.');
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  if (menu.isPending) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">Loading the menu…</span>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    );
  }
  if (menu.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm text-ink">
        The menu couldn’t be loaded.
        <Button variant="outline" size="touch" onClick={() => void menu.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (menu.data.length === 0) {
    return (
      <EmptyState
        icon={PackageCheck}
        title="No dishes on the menu yet"
        description="A manager can add dishes in the admin panel."
        className="flex-1"
      />
    );
  }

  const shown = filterMenu(menu.data, search, false);

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-ink">Availability</h1>
        <p className="text-sm text-ink-muted">
          Switch a dish off when it runs out. Customers see it as not available straight away.
        </p>
      </div>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
        />
        <Input
          type="search"
          aria-label="Search dishes"
          placeholder="Search dishes"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-11 pl-9 text-base"
        />
      </div>

      {shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-muted">
          No dishes match “{search.trim()}”.
        </p>
      ) : (
        shown.map((category) => (
          <section
            key={category.id}
            aria-labelledby={`${ids}-${category.id}`}
            className="rounded-lg border border-line bg-surface"
          >
            <h2
              id={`${ids}-${category.id}`}
              className="border-b border-line px-4 py-2 text-sm font-semibold text-ink-muted"
            >
              {category.name}
            </h2>
            <ul>
              {category.items.map((item) => (
                <li
                  key={item.id}
                  className="flex min-h-14 items-center justify-between gap-3 border-b border-line px-4 py-2 last:border-b-0"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2 text-base text-ink">
                      <FoodTypeMark type={item.foodType} size="sm" />
                      {item.name}
                    </span>
                    {item.variants.length > 0 && (
                      <span className="text-sm text-ink-muted">
                        {item.variants.map((variant) => variant.name).join(' · ')}
                      </span>
                    )}
                  </span>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-ink">
                    <span className={item.isAvailable ? 'text-ink' : 'text-ink-muted'}>
                      {item.isAvailable ? 'In stock' : 'Out of stock'}
                    </span>
                    <Switch
                      checked={item.isAvailable}
                      onCheckedChange={(available) => toggle.mutate({ item, available })}
                      aria-label={`${item.name} in stock`}
                    />
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
