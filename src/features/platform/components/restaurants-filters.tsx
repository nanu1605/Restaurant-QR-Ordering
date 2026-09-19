'use client';

import { usePathname, useRouter } from 'next/navigation';
import type { FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { hrefWithParams } from '@/lib/date-range';

import { filterParams, type RestaurantFilters } from '../params';
import { SUBSCRIPTION_STATUS_LABELS, SUBSCRIPTION_STATUSES } from '../platform';

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

type RestaurantsFiltersProps = {
  filters: RestaurantFilters;
  cities: string[];
  plans: { code: string; name: string }[];
};

/** Search and filters for the restaurants list (spec §13.4); everything lives in the URL. */
export function RestaurantsFilters({ filters, cities, plans }: RestaurantsFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const current = filterParams(filters);

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };
    router.push(
      hrefWithParams(pathname, {
        q: text('q'),
        status: text('status'),
        plan: text('plan'),
        subscription: text('subscription'),
        city: text('city'),
        from: text('from'),
        to: text('to'),
        sort: text('sort'),
      }),
    );
  }

  return (
    <form
      key={JSON.stringify(current)}
      onSubmit={apply}
      role="search"
      aria-label="Restaurants"
      className="grid gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <label className="flex flex-col gap-1 text-sm font-medium text-ink sm:col-span-2">
        Search
        <Input
          type="search"
          name="q"
          defaultValue={filters.q}
          placeholder="Name, code or city"
          className="h-11"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        Status
        <select name="status" defaultValue={filters.status ?? ''} className={SELECT_CLASS}>
          <option value="">Active and suspended</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        Subscription
        <select
          name="subscription"
          defaultValue={filters.subscription ?? ''}
          className={SELECT_CLASS}
        >
          <option value="">Any subscription</option>
          {SUBSCRIPTION_STATUSES.map((status) => (
            <option key={status} value={status}>
              {SUBSCRIPTION_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        Plan
        <select name="plan" defaultValue={filters.plan ?? ''} className={SELECT_CLASS}>
          <option value="">Any plan</option>
          {plans.map((plan) => (
            <option key={plan.code} value={plan.code}>
              {plan.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        City
        <select name="city" defaultValue={filters.city ?? ''} className={SELECT_CLASS}>
          <option value="">Any city</option>
          {cities.map((city) => (
            <option key={city} value={city}>
              {city}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        Created from
        <Input type="date" name="from" defaultValue={filters.from} className="h-11" />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        Created to
        <Input type="date" name="to" defaultValue={filters.to} className="h-11" />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        Sort by
        <select name="sort" defaultValue={filters.sort ?? 'created'} className={SELECT_CLASS}>
          <option value="created">Newest first</option>
          <option value="name">Name</option>
          <option value="last_order">Last order</option>
        </select>
      </label>
      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
        <Button type="submit" size="touch">
          Apply
        </Button>
        <Button type="button" size="touch" variant="ghost" onClick={() => router.push(pathname)}>
          Clear
        </Button>
      </div>
    </form>
  );
}
