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
import { useLive, useOffline } from '@/features/live/live-provider';
import { MENU_MUTATION_KEY, menuKey } from '@/features/live/query-client';
import { isUnrecognizedAction } from '@/features/new-version/stale';
import { filterMenu } from '@/features/ordering/menu-filter';
import type { CustomerAddonGroup, CustomerCategory } from '@/features/ordering/types';
import { createClient } from '@/lib/supabase/browser';

import { setAddonAvailability, setDishAvailability } from '../actions';
import { useStaffLang, useStaffStrings } from '../staff-lang';
import { fetchStaffMenu } from '../staff-menu';

/** What a switch changes: a dish, or one add-on option (shared by every dish in its group). */
type StockTarget = { kind: 'dish' | 'addon'; id: string; name: string };

function withAvailability(menu: CustomerCategory[], target: StockTarget, available: boolean) {
  return menu.map((category) => ({
    ...category,
    items: category.items.map((item) =>
      target.kind === 'dish'
        ? item.id === target.id
          ? { ...item, isAvailable: available }
          : item
        : {
            ...item,
            addonGroups: item.addonGroups.map((group) => ({
              ...group,
              addons: group.addons.map((addon) =>
                addon.id === target.id ? { ...addon, isAvailable: available } : addon,
              ),
            })),
          },
    ),
  }));
}

/** The add-on groups the menu's dishes use, once each, matching the search. */
function addonGroupsOf(menu: CustomerCategory[], search: string): CustomerAddonGroup[] {
  const q = search.trim().toLowerCase().replace(/\s+/g, ' ');
  const groups = new Map<string, CustomerAddonGroup>();
  for (const category of menu) {
    for (const item of category.items) {
      for (const group of item.addonGroups) groups.set(group.id, group);
    }
  }
  return [...groups.values()]
    .map((group) =>
      !q || group.name.toLowerCase().includes(q)
        ? group
        : { ...group, addons: group.addons.filter((a) => a.name.toLowerCase().includes(q)) },
    )
    .filter((group) => group.addons.length > 0);
}

/** Availability (spec §13.2): every dish and add-on with an in-stock switch, searchable. */
export function AvailabilityList() {
  const ids = useId();
  const queryClient = useQueryClient();
  const { restaurantId } = useLive();
  const t = useStaffStrings();
  const lang = useStaffLang();
  // By language too: the names differ (P11-16).
  const key = [...menuKey(restaurantId), lang];
  const [search, setSearch] = useState('');

  const menu = useQuery({
    queryKey: key,
    queryFn: () => fetchStaffMenu(createClient(), lang),
    staleTime: 60_000,
  });

  // Switches flipped in quick succession each show at once; the menu refetches
  // after the last one finishes, so none flips back in between.
  const lastChange = () => queryClient.isMutating({ mutationKey: MENU_MUTATION_KEY }) === 1;
  const toggle = useMutation({
    mutationKey: MENU_MUTATION_KEY,
    mutationFn: async ({ target, available }: { target: StockTarget; available: boolean }) => {
      const result = await (target.kind === 'dish' ? setDishAvailability : setAddonAvailability)(
        target.id,
        available,
      );
      if (!result.ok) throw new Error(t.refusal(result));
    },
    onMutate: async ({ target, available }) => {
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<CustomerCategory[]>(key, (current) =>
        current ? withAvailability(current, target, available) : current,
      );
    },
    onSuccess: (_result, { target, available }) => {
      toast.success(available ? t.stock.back(target.name) : t.stock.out(target.name));
    },
    onError: (error, { target, available }) => {
      // Put this one back; other switches keep their own pending changes.
      queryClient.setQueryData<CustomerCategory[]>(key, (current) =>
        current ? withAvailability(current, target, !available) : current,
      );
      // An older build: the refresh notice explains (docs/DECISIONS.md VPS-8).
      if (isUnrecognizedAction(error)) return;
      toast.error(
        error instanceof TypeError ? t.network : error instanceof Error ? error.message : t.generic,
      );
    },
    onSettled: () => {
      if (lastChange()) void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  if (menu.isPending) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t.add.loadingMenu}</span>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    );
  }
  if (menu.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm text-ink">
        {t.add.menuFailed}
        <Button variant="outline" size="touch" onClick={() => void menu.refetch()}>
          {t.tryAgain}
        </Button>
      </div>
    );
  }
  if (menu.data.length === 0) {
    return (
      <EmptyState
        icon={PackageCheck}
        title={t.stock.empty}
        description={t.stock.emptyHint}
        className="flex-1"
      />
    );
  }

  const shown = filterMenu(menu.data, search, false);
  const addonGroups = addonGroupsOf(menu.data, search);

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-ink">{t.stock.title}</h1>
        <p className="text-sm text-ink-muted">{t.stock.intro}</p>
      </div>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
        />
        <Input
          type="search"
          aria-label={t.add.search}
          placeholder={t.add.search}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-11 pl-9 text-base"
        />
      </div>

      {shown.length === 0 && addonGroups.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-muted">{t.stock.noMatch(search.trim())}</p>
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
                      <FoodTypeMark
                        type={item.foodType}
                        size="sm"
                        label={t.foodType[item.foodType]}
                      />
                      {item.name}
                    </span>
                    {item.variants.length > 0 && (
                      <span className="text-sm text-ink-muted">
                        {item.variants.map((variant) => variant.name).join(' · ')}
                      </span>
                    )}
                  </span>
                  <StockSwitch
                    name={item.name}
                    available={item.isAvailable}
                    onChange={(available) =>
                      toggle.mutate({
                        target: { kind: 'dish', id: item.id, name: item.name },
                        available,
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {addonGroups.map((group) => (
        <section
          key={group.id}
          aria-labelledby={`${ids}-${group.id}`}
          className="rounded-lg border border-line bg-surface"
        >
          <h2
            id={`${ids}-${group.id}`}
            className="border-b border-line px-4 py-2 text-sm font-semibold text-ink-muted"
          >
            {t.stock.addons(group.name)}
          </h2>
          <ul>
            {group.addons.map((addon) => (
              <li
                key={addon.id}
                className="flex min-h-14 items-center justify-between gap-3 border-b border-line px-4 py-2 last:border-b-0"
              >
                <span className="text-base text-ink">{addon.name}</span>
                <StockSwitch
                  name={addon.name}
                  available={addon.isAvailable}
                  onChange={(available) =>
                    toggle.mutate({
                      target: { kind: 'addon', id: addon.id, name: addon.name },
                      available,
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

type StockSwitchProps = {
  name: string;
  available: boolean;
  onChange: (available: boolean) => void;
};

function StockSwitch({ name, available, onChange }: StockSwitchProps) {
  const offline = useOffline();
  const t = useStaffStrings();
  return (
    // Not a <label>: it would rename the switch after its status text.
    <div className="flex min-h-11 items-center gap-3 text-sm font-medium">
      <span aria-hidden className={available ? 'text-ink' : 'text-ink-muted'}>
        {available ? t.stock.inStock : t.stock.outOfStock}
      </span>
      <Switch
        checked={available}
        onCheckedChange={onChange}
        disabled={offline}
        aria-label={t.stock.switchLabel(name)}
      />
    </div>
  );
}
